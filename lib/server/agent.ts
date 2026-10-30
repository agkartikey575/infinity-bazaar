// The agent's payment service. The browser only names a run (kind, id, seed)
// and a line; the server replays the deterministic engine, computes the amount
// itself, runs AgentGuard against the signed ledger, and only then calls PayPal.
import { checkPayment, getItem, type GuardDecision } from "../../src/engine/index.ts";
import { toCents, toValue, type Cents } from "../money.ts";
import { buildMissionRun, buildSingleRun, type Run } from "../timeline.ts";
import { committedCents, transition, type Ledger, type LedgerEntry, type RunRef } from "./ledger.ts";
import { approveLink, paymentIds, PayPalClient, PayPalError } from "./paypal.ts";

export interface LogRow {
  /** What happened, in one line, as shown in the checkout rail. */
  text: string;
  debugId?: string | null;
}

export type PayResult =
  | { decision: "block"; guard: GuardDecision; ledger: Ledger; log: LogRow[] }
  | { decision: "ask_user"; guard: GuardDecision; ledger: Ledger; log: LogRow[] }
  | { decision: "needs_paypal_approval"; guard: GuardDecision; ledger: Ledger; log: LogRow[]; orderId: string; approveUrl: string }
  | { decision: "paid"; state: "captured" | "authorized"; guard: GuardDecision; ledger: Ledger; log: LogRow[] };

export function rebuildRun(ref: RunRef): Run {
  if (ref.kind === "mission") return buildMissionRun(ref.id, ref.seed);
  return buildSingleRun(ref.id, ref.seed, ref.kind === "rogue");
}

/** Stable per run and line, so PayPal request ids and invoice ids repeat on retries. */
export const lineKey = (ref: RunRef, line: number) => `${ref.kind}-${ref.id}-${ref.seed}-${line}`;

/** Simulated PayPal: same shapes, deterministic ids, no network. Used when no keys are set. */
export class SimulatedPayPal {
  private n = 0;
  private id(prefix: string, key: string) {
    let h = 0;
    for (const c of `${key}:${prefix}:${this.n++}`) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return `${prefix}${h.toString(36).toUpperCase().padStart(10, "0")}`.slice(0, 17);
  }
  order(key: string) {
    return this.id("SIM", key);
  }
}

interface Ctx {
  paypal: PayPalClient | null;
  /** Saved PayPal wallet (vault id) for paying with no buyer present. */
  vaultId: string | null;
  /** Where PayPal sends the buyer back after approving. */
  returnUrl: string;
}

function lineFor(run: Run, line: number) {
  const l = run.lines[line];
  if (!l) throw new Error(`no line ${line}`);
  const o = l.deal.outcome;
  if (o.status !== "deal" || o.amountToPay === undefined || o.price === undefined) throw new Error(`line ${line} has no deal`);
  return { l, o, item: getItem(l.itemId) };
}

/** AgentGuard, run on the server against the ledger. */
export function guardLine(run: Run, line: number, ledger: Ledger): { guard: GuardDecision; amount: Cents } {
  const { l, o, item } = lineFor(run, line);
  const spent = committedCents(ledger) - (ledger.entries[line]?.state === "pending_approval" ? ledger.entries[line].amountCents : 0);
  const guard = checkPayment({
    amount: o.amountToPay!,
    currency: "USD",
    spentSoFar: spent / 100,
    sellerId: o.sellerName ?? o.sellerId ?? "",
    sellerName: o.sellerName ?? "",
    group: item.group,
    alreadyPaid: ["authorized", "captured"].includes(ledger.entries[line]?.state ?? ""),
    agreedAmount: o.price! + o.fee,
    surpriseFee: o.surpriseFee,
    laterFee: o.futureFee,
    rules: l.rules,
  });
  return { guard, amount: toCents(o.amountToPay!) };
}

const intentOf = (itemId: string) => (getItem(itemId).paypalFlow === "capture_now" ? "CAPTURE" : "AUTHORIZE");

/**
 * Pay one line. `userApproved` is true once the person approved an "ask you"
 * payment in the deal room. Blocked payments never reach PayPal.
 */
export async function pay(ref: RunRef, line: number, ledger: Ledger, userApproved: boolean, ctx: Ctx): Promise<PayResult> {
  const run = rebuildRun(ref);
  const { l, o, item } = lineFor(run, line);
  const { guard, amount } = guardLine(run, line, ledger);
  const log: LogRow[] = [{ text: `AgentGuard (server): ${guard.summary}` }];

  if (guard.decision === "block") {
    return { decision: "block", guard, ledger: transition(ledger, line, { state: "blocked", amountCents: amount }), log: [...log, { text: "No call to PayPal was made." }] };
  }
  if (guard.decision === "ask_user" && !userApproved) return { decision: "ask_user", guard, ledger, log };

  const key = lineKey(ref, line);
  const intent = intentOf(l.itemId);
  const useVault = guard.decision === "approve" && ctx.vaultId !== null;
  const order = {
    intent,
    lineKey: key,
    description: `${item.name} from ${o.sellerName}`,
    itemName: item.name,
    itemCents: toCents(o.price!),
    feeCents: toCents(o.fee),
    feeKind: item.delivery === "shipped" ? "shipping" : "handling",
    category: item.delivery === "instant" ? "DIGITAL_GOODS" : "PHYSICAL_GOODS",
    vaultId: useVault ? ctx.vaultId! : undefined,
    returnUrl: `${ctx.returnUrl}?line=${line}`,
    cancelUrl: `${ctx.returnUrl}?line=${line}&cancel=1`,
  } as const;

  // Simulated mode: no keys configured.
  if (!ctx.paypal) {
    const sim = new SimulatedPayPal();
    const id = sim.order(key);
    const state = intent === "CAPTURE" ? "captured" : "authorized";
    const entry: LedgerEntry = { state, amountCents: amount, orderId: id, [state === "captured" ? "captureId" : "authorizationId"]: sim.order(key) };
    return {
      decision: "paid",
      state,
      guard,
      ledger: transition(ledger, line, entry),
      log: [...log, { text: `(simulated) POST /v2/checkout/orders · intent ${intent} · $${toValue(amount)} → ${state === "captured" ? "COMPLETED" : "authorization CREATED"} · ${id}` }],
    };
  }

  const created = await ctx.paypal.createOrder(order, `${key}:create`);
  const orderId = created.data.id;
  log.push({ text: `${created.label} · intent ${intent} · $${toValue(amount)}${useVault ? " · vaulted wallet" : ""} → ${created.data.status} · order ${orderId}`, debugId: created.debugId });

  if (created.data.status === "COMPLETED") {
    const ids = paymentIds(created.data);
    const state = intent === "CAPTURE" ? "captured" : "authorized";
    return {
      decision: "paid",
      state,
      guard,
      ledger: transition(ledger, line, { state, amountCents: amount, orderId, captureId: ids.captureId ?? undefined, authorizationId: ids.authorizationId ?? undefined }),
      log: [...log, { text: state === "captured" ? `Captured ${ids.captureId}` : `Authorized ${ids.authorizationId}: money held until delivery` }],
    };
  }

  const approveUrl = approveLink(created.data.links);
  if (!approveUrl) throw new PayPalError(500, "NO_APPROVE_LINK", `order ${orderId} is ${created.data.status} with no approval link`, null, created.debugId);
  return {
    decision: "needs_paypal_approval",
    guard,
    ledger: transition(ledger, line, { state: "pending_approval", amountCents: amount, orderId }),
    log,
    orderId,
    approveUrl,
  };
}

/** After the buyer approved in PayPal: capture or authorize the order. */
export async function complete(ref: RunRef, line: number, ledger: Ledger, paypal: PayPalClient | null): Promise<{ ledger: Ledger; log: LogRow[]; state: "captured" | "authorized" }> {
  const entry = ledger.entries[line];
  if (!entry || entry.state !== "pending_approval" || !entry.orderId) throw new Error(`line ${line} has no order waiting for approval`);
  const run = rebuildRun(ref);
  const intent = intentOf(lineFor(run, line).l.itemId);
  if (!paypal) throw new Error("PayPal is not configured");
  const key = lineKey(ref, line);
  const res = intent === "CAPTURE" ? await paypal.captureOrder(entry.orderId, `${key}:capture`) : await paypal.authorizeOrder(entry.orderId, `${key}:authorize`);
  const ids = paymentIds(res.data);
  const state = intent === "CAPTURE" ? "captured" : "authorized";
  return {
    state,
    ledger: transition(ledger, line, { state, amountCents: entry.amountCents, captureId: ids.captureId ?? undefined, authorizationId: ids.authorizationId ?? undefined }),
    log: [{ text: `${res.label} → ${res.data.status} · ${state === "captured" ? `capture ${ids.captureId}` : `authorization ${ids.authorizationId}: money held until delivery`}`, debugId: res.debugId }],
  };
}

/** The buyer cancelled in PayPal or declined in the deal room. Nothing to undo at PayPal. */
export function decline(line: number, ledger: Ledger, amountCents: number): Ledger {
  return transition(ledger, line, { state: "declined", amountCents });
}

/** Delivery: the server decides from the deal whether it arrived. Capture the hold, or void it. */
export async function deliver(ref: RunRef, line: number, ledger: Ledger, paypal: PayPalClient | null): Promise<{ ledger: Ledger; log: LogRow[]; state: "captured" | "voided" }> {
  const entry = ledger.entries[line];
  if (!entry || entry.state !== "authorized") throw new Error(`line ${line} has no authorization to settle`);
  const run = rebuildRun(ref);
  const { o } = lineFor(run, line);
  const failed = o.afterPayment !== null;
  const key = lineKey(ref, line);
  if (!paypal || !entry.authorizationId || entry.authorizationId.startsWith("SIM")) {
    const state = failed ? "voided" : "captured";
    return { state, ledger: transition(ledger, line, { state, amountCents: entry.amountCents }), log: [{ text: `(simulated) ${failed ? "void" : "capture"} of the hold → ${failed ? "VOIDED" : "COMPLETED"}` }] };
  }
  if (failed) {
    const res = await paypal.voidAuthorization(entry.authorizationId, `${key}:void`);
    return { state: "voided", ledger: transition(ledger, line, { state: "voided", amountCents: entry.amountCents }), log: [{ text: `${res.label} → VOIDED · hold released`, debugId: res.debugId }] };
  }
  const res = await paypal.captureAuthorization(entry.authorizationId, `${key}:capture-auth`);
  return {
    state: "captured",
    ledger: transition(ledger, line, { state: "captured", amountCents: entry.amountCents, captureId: res.data.id }),
    log: [{ text: `${res.label} → ${res.data.status} · capture ${res.data.id}`, debugId: res.debugId }],
  };
}
