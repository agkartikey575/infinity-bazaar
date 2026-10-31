// The agent's payment service. The browser only names a run (kind, id, seed,
// nonce) and a line; the server replays the deterministic engine, computes the
// amount itself, runs AgentGuard against the signed ledger, and only then calls PayPal.
import { checkPayment, getItem, type GuardDecision } from "../../src/engine/index.ts";
import { toCents, toValue, type Cents } from "../money.ts";
import { buildMissionRun, buildSingleRun, type Run } from "../timeline.ts";
import { committedCents, transition, type Ledger, type LedgerEntry, type RunRef } from "./ledger.ts";
import { approveLink, paymentIds, paymentSucceeded, PayPalClient, PayPalError, type Order } from "./paypal.ts";

export interface LogRow {
  /** What happened, in one line, as shown in the checkout rail. */
  text: string;
  debugId?: string | null;
}

export type PayResult =
  | { decision: "block"; guard: GuardDecision; ledger: Ledger; log: LogRow[] }
  | { decision: "ask_user"; guard: GuardDecision; ledger: Ledger; log: LogRow[] }
  | { decision: "needs_paypal_approval"; guard: GuardDecision; ledger: Ledger; log: LogRow[]; orderId: string; approveUrl: string }
  | { decision: "paid"; state: "captured" | "authorized"; guard: GuardDecision; ledger: Ledger; log: LogRow[] }
  | { decision: "declined"; guard: GuardDecision; ledger: Ledger; log: LogRow[] };

export function rebuildRun(ref: RunRef): Run {
  if (ref.kind === "mission") return buildMissionRun(ref.id, ref.seed);
  return buildSingleRun(ref.id, ref.seed, ref.kind === "rogue");
}

/**
 * Stable per run and line, so retries reuse PayPal request ids and invoice ids.
 * The nonce makes every Play unique: two visitors on the same table never share ids.
 */
export const lineKey = (ref: RunRef, line: number) => `${ref.nonce}-${line}`;

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
  const own = ledger.entries[line];
  const spent = committedCents(ledger) - (own?.state === "pending_approval" ? own.amountCents : 0);
  const guard = checkPayment({
    amount: o.amountToPay!,
    currency: "USD",
    spentSoFar: spent / 100,
    sellerId: o.sellerName ?? o.sellerId ?? "",
    sellerName: o.sellerName ?? "",
    group: item.group,
    alreadyPaid: ["authorized", "captured"].includes(own?.state ?? ""),
    agreedAmount: o.price! + o.fee,
    surpriseFee: o.surpriseFee,
    laterFee: o.futureFee,
    rules: l.rules,
  });
  return { guard, amount: toCents(o.amountToPay!) };
}

const intentOf = (itemId: string) => (getItem(itemId).paypalFlow === "capture_now" ? "CAPTURE" : "AUTHORIZE");

/** Ledger update and log line for an order PayPal reports as paid (or not). */
function settleOrder(ledger: Ledger, line: number, amount: number, order: Order, intent: "CAPTURE" | "AUTHORIZE", label: string, debugId: string | null) {
  const ids = paymentIds(order);
  if (!paymentSucceeded(ids.status)) {
    return {
      state: "declined" as const,
      ledger: transition(ledger, line, { state: "declined", amountCents: amount, orderId: order.id }),
      log: [{ text: `${label} → payment ${ids.status ?? "missing"}. No money moved.`, debugId }],
    };
  }
  const state = intent === "CAPTURE" ? ("captured" as const) : ("authorized" as const);
  return {
    state,
    ledger: transition(ledger, line, { state, amountCents: amount, orderId: order.id, captureId: ids.captureId ?? undefined, authorizationId: ids.authorizationId ?? undefined }),
    log: [{ text: `${label} → ${ids.status} · ${state === "captured" ? `capture ${ids.captureId}` : `authorization ${ids.authorizationId}: money held until delivery`}`, debugId }],
  };
}

/**
 * Pay one line. `userApproved` is true once the person approved an "ask you"
 * payment in the deal room. Blocked payments never reach PayPal. Calling again
 * for a line that is already paid or waiting for PayPal resumes it.
 */
export async function pay(ref: RunRef, line: number, ledger: Ledger, userApproved: boolean, ctx: Ctx): Promise<PayResult> {
  const run = rebuildRun(ref);
  const { l, o, item } = lineFor(run, line);
  const own = ledger.entries[line];
  const { guard, amount } = guardLine(run, line, ledger);

  // Resume: already paid, or an order waiting for the buyer.
  if (own?.state === "authorized" || own?.state === "captured") return { decision: "paid", state: own.state, guard, ledger, log: [] };
  if (own?.state === "pending_approval" && own.orderId && ctx.paypal) {
    const cur = await ctx.paypal.getOrder(own.orderId);
    if (cur.data.status === "APPROVED") {
      const done = await complete(ref, line, ledger, ctx.paypal);
      if ("needsApproval" in done) return { decision: "needs_paypal_approval", guard, ledger: done.ledger, log: done.log, orderId: own.orderId, approveUrl: done.approveUrl };
      return done.state === "declined" ? { decision: "declined", guard, ledger: done.ledger, log: done.log } : { decision: "paid", state: done.state, guard, ledger: done.ledger, log: done.log };
    }
    const url = approveLink(cur.data.links);
    if (url) return { decision: "needs_paypal_approval", guard, ledger, log: [], orderId: own.orderId, approveUrl: url };
  }

  const log: LogRow[] = [{ text: `AgentGuard (server): ${guard.summary}` }];
  if (guard.decision === "block") {
    return { decision: "block", guard, ledger: transition(ledger, line, { state: "blocked", amountCents: amount }), log: [...log, { text: "No call to PayPal was made." }] };
  }
  if (guard.decision === "ask_user" && !userApproved) return { decision: "ask_user", guard, ledger, log };

  // One source of truth for the amount: what AgentGuard checked is what PayPal charges.
  const itemCents = toCents(o.price!);
  const feeCents = toCents(o.fee);
  if (itemCents + feeCents !== amount) throw new Error(`amount mismatch on line ${line}`);

  const key = lineKey(ref, line);
  const intent = intentOf(l.itemId);
  const useVault = guard.decision === "approve" && ctx.vaultId !== null;
  const order = {
    intent,
    lineKey: key,
    description: `${item.name} from ${o.sellerName}`,
    itemName: item.name,
    itemCents,
    feeCents,
    feeKind: item.delivery === "shipped" ? "shipping" : "handling",
    category: item.delivery === "instant" ? "DIGITAL_GOODS" : "PHYSICAL_GOODS",
    shipped: item.delivery === "shipped",
    vaultId: useVault ? ctx.vaultId! : undefined,
    returnUrl: `${ctx.returnUrl}?line=${line}`,
    cancelUrl: `${ctx.returnUrl}?line=${line}&cancel=1`,
  } as const;

  // Simulated mode: no keys configured.
  if (!ctx.paypal) {
    const id = `SIM${key.replace(/[^A-Z0-9]/gi, "").toUpperCase().slice(0, 14)}`;
    const state = intent === "CAPTURE" ? "captured" : "authorized";
    const entry: LedgerEntry = { state, amountCents: amount, orderId: id, [state === "captured" ? "captureId" : "authorizationId"]: `${id}P` };
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
    const s = settleOrder(ledger, line, amount, created.data, intent, created.label, created.debugId);
    return s.state === "declined"
      ? { decision: "declined", guard, ledger: s.ledger, log: [...log, ...s.log] }
      : { decision: "paid", state: s.state, guard, ledger: s.ledger, log: [...log, ...s.log] };
  }

  const approveUrl = approveLink(created.data.links);
  if (!approveUrl) throw new PayPalError(502, "NO_APPROVE_LINK", `order ${orderId} is ${created.data.status} with no approval link`, null, created.debugId);
  return {
    decision: "needs_paypal_approval",
    guard,
    ledger: transition(ledger, line, { state: "pending_approval", amountCents: amount, orderId }),
    log,
    orderId,
    approveUrl,
  };
}

export type CompleteResult =
  | { ledger: Ledger; log: LogRow[]; state: "captured" | "authorized" | "declined" }
  /** Not approved yet, or the wallet was declined: the buyer must approve (again). */
  | { ledger: Ledger; log: LogRow[]; needsApproval: true; approveUrl: string };

/** After the buyer approved in PayPal: capture or authorize the order. */
export async function complete(ref: RunRef, line: number, ledger: Ledger, paypal: PayPalClient | null): Promise<CompleteResult> {
  const entry = ledger.entries[line];
  if (!entry || entry.state !== "pending_approval" || !entry.orderId) throw new Error(`line ${line} has no order waiting for approval`);
  if (!paypal) throw new Error("PayPal is not configured");
  const run = rebuildRun(ref);
  const intent = intentOf(lineFor(run, line).l.itemId);
  const attempt = entry.attempt ?? 0;
  const requestId = `${lineKey(ref, line)}:${intent === "CAPTURE" ? "capture" : "authorize"}:${attempt}`;
  try {
    const res = intent === "CAPTURE" ? await paypal.captureOrder(entry.orderId, requestId) : await paypal.authorizeOrder(entry.orderId, requestId);
    return settleOrder(ledger, line, entry.amountCents, res.data, intent, res.label, res.debugId);
  } catch (e) {
    if (!(e instanceof PayPalError)) throw e;
    // Already done on PayPal's side (a retry after a lost reply): read the order and record it.
    if (e.issue === "ORDER_ALREADY_CAPTURED" || e.issue === "ORDER_ALREADY_AUTHORIZED") {
      const cur = await paypal.getOrder(entry.orderId);
      return settleOrder(ledger, line, entry.amountCents, cur.data, intent, cur.label, cur.debugId);
    }
    // Not approved yet, or the buyer's funding was declined: send them back to PayPal.
    if (e.issue === "ORDER_NOT_APPROVED" || e.issue === "INSTRUMENT_DECLINED") {
      const cur = await paypal.getOrder(entry.orderId);
      const url = approveLink(cur.data.links);
      if (!url) throw e;
      const next = e.issue === "INSTRUMENT_DECLINED" ? attempt + 1 : attempt;
      return {
        needsApproval: true,
        approveUrl: url,
        ledger: transition(ledger, line, { state: "pending_approval", amountCents: entry.amountCents, attempt: next }),
        log: [{ text: e.issue === "INSTRUMENT_DECLINED" ? "PayPal declined that payment method. Choose another in PayPal." : "Not approved in PayPal yet.", debugId: e.debugId }],
      };
    }
    throw e;
  }
}

/** The buyer declined, in the deal room or with Cancel in PayPal. Nothing to undo at PayPal. */
export function decline(line: number, ledger: Ledger, amountCents: number): Ledger {
  return transition(ledger, line, { state: "declined", amountCents });
}

/** Delivery: the server decides from the deal whether it arrived. Capture the hold, or void it. */
export async function deliver(ref: RunRef, line: number, ledger: Ledger, paypal: PayPalClient | null): Promise<{ ledger: Ledger; log: LogRow[]; state: "captured" | "voided" }> {
  const entry = ledger.entries[line];
  if (entry?.state === "captured" || entry?.state === "voided") return { ledger, log: [], state: entry.state };
  if (!entry || entry.state !== "authorized") throw new Error(`line ${line} has no authorization to settle`);
  const run = rebuildRun(ref);
  const { o } = lineFor(run, line);
  const failed = o.afterPayment !== null;
  const key = lineKey(ref, line);
  if (!paypal) {
    const state = failed ? "voided" : "captured";
    return { state, ledger: transition(ledger, line, { state, amountCents: entry.amountCents }), log: [{ text: `(simulated) ${failed ? "void" : "capture"} of the hold → ${failed ? "VOIDED" : "COMPLETED"}` }] };
  }
  if (!entry.authorizationId) throw new Error(`line ${line} is authorized but has no authorization id`);
  if (failed) {
    const res = await paypal.voidAuthorization(entry.authorizationId, `${key}:void`);
    return { state: "voided", ledger: transition(ledger, line, { state: "voided", amountCents: entry.amountCents }), log: [{ text: `${res.label} → VOIDED · hold released`, debugId: res.debugId }] };
  }
  const res = await paypal.captureAuthorization(entry.authorizationId, `${key}:capture-auth`);
  if (!paymentSucceeded(res.data.status)) throw new PayPalError(502, "CAPTURE_NOT_COMPLETED", `capture is ${res.data.status}`, null, res.debugId);
  return {
    state: "captured",
    ledger: transition(ledger, line, { state: "captured", amountCents: entry.amountCents, captureId: res.data.id }),
    log: [{ text: `${res.label} → ${res.data.status} · capture ${res.data.id}`, debugId: res.debugId }],
  };
}
