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
  | { type: "paypal"; line: number; text: string; detail: string; effect?: "authorized" | "captured" | "voided" }
  | { type: "event"; line: number; text: string }
  | { type: "line-end"; line: number };

/** Deterministic PayPal-style ids, so a replay shows the same ids. */
function paypalId(seed: number, line: number, salt: number): string {
  const rng = createRng((seed * 31 + line * 977 + salt * 7919) >>> 0);
  const chars = "ABCDEFGHJKLMNPRSTUVWXYZ0123456789";
  return Array.from({ length: 17 }, () => chars[Math.floor(rng.next() * chars.length)]).join("");
}

const money = (n: number) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);

/** How a delivery is announced, by kind of item. */
function deliveredText(delivery: string, group: string, seller: string): string {
  if (delivery === "service") return `${seller} delivered the work.`;
  if (group === "fun") return `${seller}'s order arrived.`;
  return `${seller}'s package arrived.`;
}

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
          steps.push({ type: "paypal", line: i, text: `PayPal order created for ${money(amount)}.`, detail: `POST /v2/checkout/orders · intent ${intent} · ${money(amount)} → order ${orderId} PAYER_ACTION_REQUIRED` });
          steps.push({ type: "paypal", line: i, text: "You approved the payment in PayPal.", detail: `Buyer approved order ${orderId}` });
        }
        const call = viaPopup
          ? `POST /v2/checkout/orders/${orderId}/${intent === "CAPTURE" ? "capture" : "authorize"}`
          : `POST /v2/checkout/orders · intent ${intent} · ${money(amount)} · vaulted PayPal wallet, no buyer present`;
        const seller = o.sellerName ?? "the seller";
        if (item.paypalFlow === "capture_now") {
          steps.push({ type: "paypal", line: i, text: `Paid ${money(amount)} to ${seller}.`, detail: `${call} → COMPLETED · capture ${txId}`, effect: "captured" });
          committed += amount;
        } else {
          steps.push({ type: "paypal", line: i, text: `${money(amount)} held by PayPal until delivery.`, detail: `${call} → authorization ${txId} CREATED`, effect: "authorized" });
          committed += amount;
          if (o.afterPayment) {
            steps.push({ type: "event", line: i, text: o.afterPayment.text });
            steps.push({ type: "paypal", line: i, text: `Delivery failed, so the hold was released. You paid nothing.`, detail: `POST /v2/payments/authorizations/${txId}/void → VOIDED`, effect: "voided" });
            committed -= amount;
          } else {
            steps.push({ type: "event", line: i, text: deliveredText(item.delivery, item.group, seller) });
            steps.push({ type: "paypal", line: i, text: `Delivered. ${money(amount)} paid to ${seller}.`, detail: `POST /v2/payments/authorizations/${txId}/capture → COMPLETED`, effect: "captured" });
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
  /** Real PayPal: waiting for you in the PayPal window. */
  | "paying"
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
  /** The agent's latest price sent to this seller, if any. */
  offer: number | null;
  /** A fee this seller revealed, added on top of the price. */
  fee: number | null;
  /** Counts of priced moves, so the screen can animate each one once. */
  offerSeq: number;
  askSeq: number;
  messages: Message[];
}

export interface Message {
  from: "agent" | "seller";
  text: string;
  tag?: string;
  tagKind?: "detect" | "move";
}

/** One entry of the whole conversation, in the order it happened. */
export interface TranscriptEntry extends Message {
  /** Seller names the agent spoke to, or the seller who spoke. */
  names: string[];
  sellerIndex: number | null;
}

export interface CheckoutRow {
  text: string;
  tone: "info" | "ok" | "ask" | "bad";
  /** Rows from simulated PayPal steps, replaced by real calls in live mode. */
  source?: "paypal" | "guard";
  /** The PayPal API call behind this row, shown only with "Show PayPal details". */
  detail?: string;
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
  transcript: TranscriptEntry[];
  /** The agent's latest priced move to any seller. */
  agentOffer: number | null;
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

/** Agent moves whose price is an offer on the table. */
const PRICED_MOVES: string[] = ["anchor", "offer", "accept", "accept-upsell", "absorb-fee"];

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
  let transcript: TranscriptEntry[] = [];
  let agentOffer: number | null = null;
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
        booths = ln.deal.sellers.map((s) => ({ id: s.id, name: s.name, archetype: s.archetype, price: s.openAsk, state: "open", offer: null, fee: null, offerSeq: 0, askSeq: 0, messages: [] }));
        commentary = [];
        transcript = [];
        agentOffer = null;
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
          const priced = b.price !== undefined && PRICED_MOVES.includes(b.move);
          for (const id of b.to) {
            const booth = booths.find((x) => x.id === id);
            if (!booth) continue;
            booth.messages.push({ from: "agent", text: b.text, tag: AGENT_TAG[b.move], tagKind: "move" });
            if (priced) {
              booth.offer = b.price!;
              booth.offerSeq++;
            }
          }
          if (priced) agentOffer = b.price!;
          transcript.push({
            from: "agent",
            text: b.text,
            tag: AGENT_TAG[b.move],
            tagKind: "move",
            names: b.to.map((id) => booths.find((x) => x.id === id)?.name ?? id),
            sellerIndex: null,
          });
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
            transcript.push({ from: "seller", text: b.text, names: [booth.name], sellerIndex: booths.indexOf(booth) });
            if (b.price !== undefined && (b.move === "counter" || b.move === "final" || b.move === "accept" || b.move === "absorb-fee")) {
              if (b.price !== booth.price) booth.askSeq++;
              booth.price = b.price;
            }
            if (b.price !== undefined && (b.move === "reveal-fee" || b.move === "surprise-fee")) booth.fee = b.price;
            if (b.move === "exit") booth.state = "out";
          }
        } else if (b.kind === "detect") {
          const booth = booths.find((x) => x.id === b.sellerId);
          const last = booth?.messages.at(-1);
          if (last && last.from === "seller" && !last.tag) {
            last.tag = b.text;
            last.tagKind = "detect";
          } else booth?.messages.push({ from: "seller", text: "", tag: b.text, tagKind: "detect" });
          const lastT = transcript.at(-1);
          if (booth && lastT && lastT.from === "seller" && lastT.names[0] === booth.name && !lastT.tag) {
            lastT.tag = b.text;
            lastT.tagKind = "detect";
          } else if (booth) transcript.push({ from: "seller", text: "", tag: b.text, tagKind: "detect", names: [booth.name], sellerIndex: booths.indexOf(booth) });
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
          ...step.guard.checks.map((c) => ({ text: `${c.pass ? "✓" : "✗"} ${c.label}`, tone: (c.pass ? "info" : "bad") as CheckoutRow["tone"], source: "guard" as const })),
          { text: step.guard.summary, tone: step.guard.decision === "approve" ? "ok" : step.guard.decision === "ask_user" ? "ask" : "bad", source: "guard" },
        ];
        if (step.guard.decision === "block") {
          statuses[step.line] = "blocked";
          say(o.rogue ? "Blocked! The seller talked the agent into it, but AgentGuard said no. $0 spent." : "AgentGuard blocked the payment. No money moved.");
        }
        break;
      }
      case "approval":
        statuses[step.line] = "awaiting-approval";
        amounts[step.line] = o.amountToPay ?? null;
        break;
      case "decision":
        checkout.push({ text: step.decision === "approved" ? "You approved the payment." : "You declined. No money moved.", tone: step.decision === "approved" ? "ok" : "bad", source: "guard" });
        if (step.decision === "declined") {
          statuses[step.line] = "declined";
          amounts[step.line] = null;
          say("You said no. The agent keeps your money.");
        }
        break;
      case "paypal":
        checkout.push({ text: step.text, tone: step.effect ? "ok" : "info", source: "paypal", detail: step.detail });
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
        if (o.status !== "deal") checkout = [{ text: "No seller met our price, so the agent walked away. Nothing was spent.", tone: "info", source: "guard" }];
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
    transcript,
    agentOffer,
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
