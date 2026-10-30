// Turns engine results into a step-by-step timeline the deal room plays back,
// and works out what the screen shows at any point in that timeline.
// AgentGuard runs here at playback time against a live ledger, so declines,
// voids free money for the lines that follow.
import { capFor, checkPayment, createRng, getItem, getMission, missionRules, runDeal, runMission } from "../src/engine/index.ts";
import type { Beat, BuyerPlan, DealResult, GuardDecision, GuardRules } from "../src/engine/index.ts";

export interface Line {
  itemId: string;
  itemName: string;
  itemCapUsd: number;
  rules: GuardRules;
  deal: DealResult;
}

export interface Run {
  kind: "mission" | "single" | "rogue";
  title: string;
  goal: string;
  budgetUsd: number;
  askAboveUsd: number;
  seed: number;
  lines: Line[];
}

const SINGLE_RULES = { budgetUsd: 300, askAboveUsd: 100 };

export function buildMissionRun(missionId: string, seed: number): Run {
  const mission = getMission(missionId);
  const result = runMission(missionId, { seed });
  return {
    kind: "mission",
    title: mission.title,
    goal: mission.goal,
    budgetUsd: mission.budgetUsd,
    askAboveUsd: mission.askAboveUsd,
    seed,
    lines: result.lines.map((l) => ({ itemId: l.itemId, itemName: l.itemName, itemCapUsd: l.itemCapUsd, rules: missionRules(mission, l.itemCapUsd), deal: l.deal })),
  };
}

export function buildSingleRun(itemId: string, seed: number, rogue = false): Run {
  const item = getItem(itemId);
  const mission = getMission("hackathon-10-days");
  const suggested = mission.suggested.find((s) => s.item === itemId)?.itemCapUsd;
  const cap = rogue ? 70 : capFor(mission, suggested ?? item.price.high, 0);
  const deal = runDeal(itemId, { seed, itemCapUsd: cap, rogue });
  return {
    kind: rogue ? "rogue" : "single",
    title: rogue ? "Rogue agent demo" : item.name,
    goal: rogue
      ? `Get me the best possible ${item.phrase.replace(/^an? /, "")}. Cap $${cap}, ask me above $${SINGLE_RULES.askAboveUsd}.`
      : `Buy ${item.phrase} (${item.unit}) at a good price.`,
    ...SINGLE_RULES,
    seed,
    lines: [{ itemId, itemName: item.name, itemCapUsd: cap, rules: { ...SINGLE_RULES, itemCapUsd: cap }, deal }],
  };
}

export type Decision = "approved" | "declined";

export type Step =
  | { type: "line-start"; line: number }
  | { type: "beat"; line: number; beat: Beat }
  | { type: "guard"; line: number; guard: GuardDecision }
  | { type: "approval"; line: number }
  | { type: "decision"; line: number; decision: Decision }
  | { type: "paypal"; line: number; text: string; effect?: "authorized" | "captured" | "voided" }
  | { type: "event"; line: number; text: string }
  | { type: "line-end"; line: number };

/** Deterministic PayPal-style ids, so a replay shows the same ids. */
function paypalId(seed: number, line: number, salt: number): string {
  const rng = createRng((seed * 31 + line * 977 + salt * 7919) >>> 0);
  const chars = "ABCDEFGHJKLMNPRSTUVWXYZ0123456789";
  return Array.from({ length: 17 }, () => chars[Math.floor(rng.next() * chars.length)]).join("");
}

const money = (n: number) => `$${n.toFixed(2)}`;

/**
 * Builds steps up to the first approval that has no decision yet.
 * `waitingFor` is that line, or null when the timeline is complete.
 */
export function buildSteps(run: Run, decisions: Record<number, Decision>): { steps: Step[]; waitingFor: number | null } {
  const steps: Step[] = [];
  let committed = 0;
  const paidLines = new Set<number>();

  for (let i = 0; i < run.lines.length; i++) {
    const line = run.lines[i];
    const item = getItem(line.itemId);
    const o = line.deal.outcome;
    steps.push({ type: "line-start", line: i });
    for (const beat of line.deal.beats) steps.push({ type: "beat", line: i, beat });

    if (o.status === "deal" && o.amountToPay !== undefined && o.sellerId) {
      const amount = o.amountToPay;
      const guard = checkPayment({
        amount,
        currency: "USD",
        spentSoFar: committed,
        sellerId: o.sellerName ?? o.sellerId,
        sellerName: o.sellerName ?? "",
        group: item.group,
        alreadyPaid: paidLines.has(i),
        agreedAmount: (o.price ?? 0) + o.fee,
        surpriseFee: o.surpriseFee,
        laterFee: o.futureFee,
        rules: line.rules,
      });
      steps.push({ type: "guard", line: i, guard });

      let pay = guard.decision === "approve";
      let viaPopup = false;
      if (guard.decision === "ask_user") {
        steps.push({ type: "approval", line: i });
        const d = decisions[i];
        if (!d) return { steps, waitingFor: i };
        steps.push({ type: "decision", line: i, decision: d });
        pay = d === "approved";
        viaPopup = pay;
      }

      if (pay) {
        const orderId = paypalId(run.seed, i, 1);
        const txId = paypalId(run.seed, i, 2);
        const intent = item.paypalFlow === "capture_now" ? "CAPTURE" : "AUTHORIZE";
        paidLines.add(i);
        if (viaPopup) {
          // Buyer present: create the order, you approve it in PayPal, then the server captures or authorizes.
          steps.push({ type: "paypal", line: i, text: `POST /v2/checkout/orders · intent ${intent} · ${money(amount)} → order ${orderId} PAYER_ACTION_REQUIRED` });
          steps.push({ type: "paypal", line: i, text: `You approved order ${orderId} in the PayPal window` });
        }
        const call = viaPopup
          ? `POST /v2/checkout/orders/${orderId}/${intent === "CAPTURE" ? "capture" : "authorize"}`
          : `POST /v2/checkout/orders · intent ${intent} · ${money(amount)} · vaulted PayPal (agent pays, no human present)`;
        if (item.paypalFlow === "capture_now") {
          steps.push({ type: "paypal", line: i, text: `${call} → COMPLETED · capture ${txId}`, effect: "captured" });
          committed += amount;
        } else {
          steps.push({ type: "paypal", line: i, text: `${call} → authorization ${txId} CREATED · money held until delivery`, effect: "authorized" });
          committed += amount;
          if (o.afterPayment) {
            steps.push({ type: "event", line: i, text: o.afterPayment.text });
            steps.push({ type: "paypal", line: i, text: `POST /v2/payments/authorizations/${txId}/void → VOIDED · ${money(amount)} hold released`, effect: "voided" });
            committed -= amount;
          } else {
            steps.push({ type: "event", line: i, text: item.delivery === "service" ? `${o.sellerName} delivered the work.` : `${o.sellerName}'s package arrived.` });
            steps.push({ type: "paypal", line: i, text: `POST /v2/payments/authorizations/${txId}/capture → COMPLETED · ${money(amount)} paid to ${o.sellerName}`, effect: "captured" });
          }
        }
      }
    }
    steps.push({ type: "line-end", line: i });
  }
  return { steps, waitingFor: null };
}

export type LineStatus =
  | "waiting"
  | "negotiating"
  | "checking"
  | "awaiting-approval"
  | "authorized"
  | "captured"
  | "declined"
  | "blocked"
  | "no-deal"
  | "voided";

export interface BoothView {
  id: string;
  name: string;
  archetype: string;
  price: number;
  state: "open" | "out" | "won" | "blocked";
  messages: { from: "agent" | "seller"; text: string; tag?: string; tagKind?: "detect" | "move" }[];
}

export interface CheckoutRow {
  text: string;
  tone: "info" | "ok" | "ask" | "bad";
}

export interface View {
  line: number;
  plan: BuyerPlan | null;
  offerIndex: number;
  dealPrice: number | null;
  booths: BoothView[];
  commentary: string[];
  event: string | null;
  checkout: CheckoutRow[];
  guard: GuardDecision | null;
  statuses: LineStatus[];
  amounts: (number | null)[];
  committedUsd: number;
  capturedUsd: number;
  pendingUsd: number;
  revealFloors: boolean;
}

const AGENT_TAG: Partial<Record<string, string>> = {
  anchor: "Anchor below market",
  leverage: "Leverage",
  "ask-fees": "Fee check",
  "ask-lever": "Trade, don't cave",
  "absorb-fee": "Fee pushback",
  "reject-fee": "Walks from the fee",
  "priced-out": "Over the limit",
  explain: "Trade-off",
  "walk-away": "Walk away",
  "accept-upsell": "Fell for the upsell",
};

/** Statuses where money is committed (held or paid). */
export const MONEY_COMMITTED: LineStatus[] = ["authorized", "captured"];

/** What the screen shows after playing steps[0..cursor). */
export function deriveView(run: Run, steps: Step[], cursor: number): View {
  const statuses: LineStatus[] = run.lines.map(() => "waiting");
  const amounts: (number | null)[] = run.lines.map(() => null);
  let line = 0;
  let booths: BoothView[] = [];
  let commentary: string[] = [];
  let event: string | null = null;
  let checkout: CheckoutRow[] = [];
  let guard: GuardDecision | null = null;
  let offerIndex = 0;
  let dealPrice: number | null = null;
  let revealFloors = false;

  const say = (t: string) => (commentary = [t, ...commentary].slice(0, 3));

  for (const step of steps.slice(0, cursor)) {
    const ln = run.lines[step.line];
    const o = ln.deal.outcome;
    switch (step.type) {
      case "line-start": {
        line = step.line;
        booths = ln.deal.sellers.map((s) => ({ id: s.id, name: s.name, archetype: s.archetype, price: s.openAsk, state: "open", messages: [] }));
        commentary = [];
        event = null;
        checkout = [];
        guard = null;
        offerIndex = 0;
        dealPrice = null;
        revealFloors = false;
        statuses[step.line] = "negotiating";
        break;
      }
      case "beat": {
        const b = step.beat;
        if (b.kind === "agent") {
          for (const id of b.to) booths.find((x) => x.id === id)?.messages.push({ from: "agent", text: b.text, tag: AGENT_TAG[b.move], tagKind: "move" });
          if (b.price !== undefined && (b.move === "offer" || b.move === "anchor")) {
            const idx = ln.deal.plan.offers.indexOf(b.price);
            if (idx >= 0) offerIndex = idx;
          }
          if (b.move === "accept") dealPrice = o.amountToPay ?? b.price ?? null;
          if (b.move === "decline" || b.move === "priced-out" || b.move === "reject-fee") for (const id of b.to) {
            const booth = booths.find((x) => x.id === id);
            if (booth) booth.state = "out";
          }
        } else if (b.kind === "seller") {
          const booth = booths.find((x) => x.id === b.sellerId);
          if (booth) {
            booth.messages.push({ from: "seller", text: b.text });
            if (b.price !== undefined && (b.move === "counter" || b.move === "final" || b.move === "accept" || b.move === "absorb-fee")) booth.price = b.price;
            if (b.move === "exit") booth.state = "out";
          }
        } else if (b.kind === "detect") {
          const booth = booths.find((x) => x.id === b.sellerId);
          const last = booth?.messages.at(-1);
          if (last && last.from === "seller" && !last.tag) {
            last.tag = b.text;
            last.tagKind = "detect";
          } else booth?.messages.push({ from: "seller", text: "", tag: b.text, tagKind: "detect" });
        } else if (b.kind === "event") {
          event = b.text;
        } else {
          say(b.text);
        }
        break;
      }
      case "guard": {
        guard = step.guard;
        statuses[step.line] = "checking";
        const winner = booths.find((x) => x.id === o.sellerId);
        for (const booth of booths) if (booth !== winner && booth.state === "open") booth.state = "out";
        if (winner) {
          winner.state = step.guard.decision === "block" ? "blocked" : "won";
          if (o.price !== undefined) winner.price = o.price;
        }
        checkout = [
          ...step.guard.checks.map((c) => ({ text: `${c.pass ? "✓" : "✗"} ${c.label}`, tone: (c.pass ? "info" : "bad") as CheckoutRow["tone"] })),
          { text: `AgentGuard: ${step.guard.summary}`, tone: step.guard.decision === "approve" ? "ok" : step.guard.decision === "ask_user" ? "ask" : "bad" },
        ];
        if (step.guard.decision === "block") {
          statuses[step.line] = "blocked";
          say(o.rogue ? "Blocked! The AI was talked into it, but the code said no. $0 spent." : "AgentGuard blocked the payment. No money moved.");
        }
        break;
      }
      case "approval":
        statuses[step.line] = "awaiting-approval";
        amounts[step.line] = o.amountToPay ?? null;
        break;
      case "decision":
        checkout.push({ text: step.decision === "approved" ? "You approved the payment." : "You declined. No money moved.", tone: step.decision === "approved" ? "ok" : "bad" });
        if (step.decision === "declined") {
          statuses[step.line] = "declined";
          amounts[step.line] = null;
          say("You said no. The agent keeps your money.");
        }
        break;
      case "paypal":
        checkout.push({ text: step.text, tone: step.effect ? "ok" : "info" });
        if (step.effect) {
          statuses[step.line] = step.effect;
          amounts[step.line] = step.effect === "voided" ? null : o.amountToPay ?? null;
        }
        break;
      case "event":
        event = step.text;
        checkout.push({ text: step.text, tone: "info" });
        break;
      case "line-end":
        revealFloors = true;
        if (statuses[step.line] === "negotiating") statuses[step.line] = "no-deal";
        if (o.status !== "deal") checkout = [{ text: "No seller came under the walk-away price. No money moved.", tone: "info" }];
        break;
    }
  }

  let committedUsd = 0;
  let capturedUsd = 0;
  let pendingUsd = 0;
  statuses.forEach((s, i) => {
    if (MONEY_COMMITTED.includes(s)) committedUsd += amounts[i] ?? 0;
    if (s === "captured") capturedUsd += amounts[i] ?? 0;
    if (s === "awaiting-approval") pendingUsd += amounts[i] ?? 0;
  });

  return {
    line,
    plan: run.lines[line]?.deal.plan ?? null,
    offerIndex,
    dealPrice,
    booths,
    commentary,
    event,
    checkout,
    guard,
    statuses,
    amounts,
    committedUsd,
    capturedUsd,
    pendingUsd,
    revealFloors,
  };
}

/** How long to dwell on a step at 1x speed, in milliseconds. */
export function stepDelay(step: Step): number {
  switch (step.type) {
    case "line-start":
      return 600;
    case "beat": {
      const b = step.beat;
      if (b.kind === "commentary") return 250;
      if (b.kind === "detect") return 700;
      if (b.kind === "event") return 1500;
      return Math.min(2600, 700 + b.text.length * 13);
    }
    case "guard":
      return 1500;
    case "paypal":
      return 1200;
    case "event":
      return 1400;
    case "line-end":
      return 2000;
    default:
      return 600;
  }
}
