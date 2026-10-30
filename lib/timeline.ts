// Turns engine results into a step-by-step timeline the deal room plays back,
// and works out what the screen shows at any point in that timeline.
import { checkPayment, getItem, getMission, runDeal, runMission } from "../src/engine/index.ts";
import type { Beat, BuyerPlan, DealResult, GuardDecision } from "../src/engine/index.ts";

export interface Line {
  itemId: string;
  itemName: string;
  itemCapUsd: number;
  deal: DealResult;
  guard: GuardDecision | null;
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

const DEFAULT_RULES = { budgetUsd: 300, askAboveUsd: 100 };

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
    lines: result.lines.map((l) => ({ itemId: l.itemId, itemName: l.itemName, itemCapUsd: l.itemCapUsd, deal: l.deal, guard: l.guard })),
  };
}

export function buildSingleRun(itemId: string, seed: number, rogue = false): Run {
  const item = getItem(itemId);
  const suggested = getMission("hackathon-10-days").suggested.find((s) => s.item === itemId)?.itemCapUsd;
  const cap = rogue ? 70 : suggested ?? item.price.high;
  const deal = runDeal(itemId, { seed, itemCapUsd: cap, rogue });
  const o = deal.outcome;
  const guard =
    o.status === "deal"
      ? checkPayment({ amount: o.amountToPay ?? o.price ?? 0, spentSoFar: 0, sellerName: o.sellerName ?? "", rules: { ...DEFAULT_RULES, itemCapUsd: cap } })
      : null;
  return {
    kind: rogue ? "rogue" : "single",
    title: rogue ? "Rogue agent demo" : item.name,
    goal: rogue
      ? `Get me the best possible ${item.name.toLowerCase()}. (Cap $${cap}, ask me above $${DEFAULT_RULES.askAboveUsd}.)`
      : `Buy a ${item.name.toLowerCase()} (${item.unit}) at a good price.`,
    ...DEFAULT_RULES,
    seed,
    lines: [{ itemId, itemName: item.name, itemCapUsd: cap, deal, guard }],
  };
}

export type Decision = "approved" | "declined";

export type Step =
  | { type: "line-start"; line: number }
  | { type: "beat"; line: number; beat: Beat }
  | { type: "guard"; line: number }
  | { type: "approval"; line: number }
  | { type: "decision"; line: number; decision: Decision }
  | { type: "paypal"; line: number; text: string; final: boolean }
  | { type: "after-payment"; line: number; text: string }
  | { type: "refund"; line: number; text: string }
  | { type: "line-end"; line: number };

/** PayPal calls for a payment. Simulated until sandbox keys are connected. */
export function paypalCalls(itemId: string, amount: number): string[] {
  const item = getItem(itemId);
  if (item.paypalFlow === "capture_now") {
    return [`POST /v2/checkout/orders (intent CAPTURE, $${amount.toFixed(2)}) → CREATED`, `POST /v2/checkout/orders/{id}/capture → COMPLETED`];
  }
  return [
    `POST /v2/checkout/orders (intent AUTHORIZE, $${amount.toFixed(2)}) → CREATED`,
    `POST /v2/checkout/orders/{id}/authorize → $${amount.toFixed(2)} held until delivery`,
  ];
}

/**
 * Builds steps up to the first approval that has no decision yet.
 * `waitingFor` is that line, or null when the timeline is complete.
 */
export function buildSteps(run: Run, decisions: Record<number, Decision>): { steps: Step[]; waitingFor: number | null } {
  const steps: Step[] = [];
  for (let i = 0; i < run.lines.length; i++) {
    const line = run.lines[i];
    steps.push({ type: "line-start", line: i });
    for (const beat of line.deal.beats) steps.push({ type: "beat", line: i, beat });

    const o = line.deal.outcome;
    if (o.status === "deal" && line.guard) {
      steps.push({ type: "guard", line: i });
      let pay = line.guard.decision === "approve";
      if (line.guard.decision === "ask_user") {
        steps.push({ type: "approval", line: i });
        const d = decisions[i];
        if (!d) return { steps, waitingFor: i };
        steps.push({ type: "decision", line: i, decision: d });
        pay = d === "approved";
      }
      if (pay) {
        const amount = o.amountToPay ?? o.price ?? 0;
        const calls = paypalCalls(line.itemId, amount);
        calls.forEach((text, k) => steps.push({ type: "paypal", line: i, text, final: k === calls.length - 1 }));
        if (o.afterPayment) {
          steps.push({ type: "after-payment", line: i, text: o.afterPayment.text });
          const held = getItem(line.itemId).paypalFlow !== "capture_now";
          steps.push({
            type: "refund",
            line: i,
            text: held
              ? `POST /v2/payments/authorizations/{id}/void → VOIDED. The $${amount.toFixed(2)} hold is released.`
              : `POST /v2/payments/captures/{id}/refund → COMPLETED. $${amount.toFixed(2)} back to you.`,
          });
        }
      }
    }
    steps.push({ type: "line-end", line: i });
  }
  return { steps, waitingFor: null };
}

export type LineStatus = "waiting" | "negotiating" | "checking" | "awaiting-approval" | "paid" | "held" | "declined" | "blocked" | "no-deal" | "refunded";

export interface BoothView {
  id: string;
  name: string;
  archetype: string;
  price: number;
  out: boolean;
  won: boolean;
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
  booths: BoothView[];
  commentary: string[];
  event: string | null;
  checkout: CheckoutRow[];
  statuses: LineStatus[];
  amounts: (number | null)[];
  spentUsd: number;
  pendingUsd: number;
  revealFloors: boolean;
}

const AGENT_TAG: Partial<Record<string, string>> = {
  anchor: "Anchor below market",
  leverage: "Leverage",
  "ask-fees": "Fee check",
  "ask-lever": "Trade, don't cave",
  "absorb-fee": "Fee pushback",
  "walk-away": "Walk away",
  "accept-upsell": "Fell for the upsell",
};

/** What the screen shows after playing steps[0..cursor). */
export function deriveView(run: Run, steps: Step[], cursor: number): View {
  const statuses: LineStatus[] = run.lines.map(() => "waiting");
  const amounts: (number | null)[] = run.lines.map(() => null);
  let line = 0;
  let booths: BoothView[] = [];
  let commentary: string[] = [];
  let event: string | null = null;
  let checkout: CheckoutRow[] = [];
  let offerIndex = 0;
  let revealFloors = false;

  const startLine = (i: number) => {
    line = i;
    const d = run.lines[i].deal;
    booths = d.sellers.map((s) => ({ id: s.id, name: s.name, archetype: s.archetype, price: s.openAsk, out: false, won: false, messages: [] }));
    commentary = [];
    event = null;
    checkout = [];
    offerIndex = 0;
    revealFloors = false;
    statuses[i] = "negotiating";
  };

  for (const step of steps.slice(0, cursor)) {
    const ln = run.lines[step.line];
    const o = ln.deal.outcome;
    switch (step.type) {
      case "line-start":
        startLine(step.line);
        break;
      case "beat": {
        const b = step.beat;
        if (b.kind === "agent") {
          for (const id of b.to) {
            const booth = booths.find((x) => x.id === id);
            booth?.messages.push({ from: "agent", text: b.text, tag: AGENT_TAG[b.move], tagKind: "move" });
          }
          if (b.price !== undefined && (b.move === "offer" || b.move === "anchor")) {
            offerIndex = Math.max(0, ln.deal.plan.offers.indexOf(b.price));
          }
        } else if (b.kind === "seller") {
          const booth = booths.find((x) => x.id === b.sellerId);
          if (booth) {
            booth.messages.push({ from: "seller", text: b.text });
            if (b.price !== undefined && b.move !== "reveal-fee" && b.move !== "surprise-fee" && b.move !== "tactic") booth.price = b.price;
            if (b.move === "exit") booth.out = true;
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
          commentary = [b.text, ...commentary].slice(0, 3);
        }
        break;
      }
      case "guard": {
        statuses[step.line] = "checking";
        if (o.sellerId) {
          for (const booth of booths) {
            booth.won = booth.id === o.sellerId;
            booth.out = booth.out || booth.id !== o.sellerId;
          }
          const winner = booths.find((x) => x.id === o.sellerId);
          if (winner && o.price !== undefined) winner.price = o.price;
        }
        const g = ln.guard!;
        checkout = [
          ...g.checks.map((c) => ({ text: `${c.pass ? "✓" : "✗"} ${c.label}`, tone: (c.pass ? "info" : "bad") as CheckoutRow["tone"] })),
          { text: `AgentGuard: ${g.summary}`, tone: g.decision === "approve" ? "ok" : g.decision === "ask_user" ? "ask" : "bad" },
        ];
        if (g.decision === "block") {
          statuses[step.line] = "blocked";
          amounts[step.line] = o.amountToPay ?? null;
        }
        break;
      }
      case "approval":
        statuses[step.line] = "awaiting-approval";
        amounts[step.line] = o.amountToPay ?? null;
        break;
      case "decision":
        checkout.push({ text: step.decision === "approved" ? "You approved the payment." : "You declined. No money moved.", tone: step.decision === "approved" ? "ok" : "bad" });
        if (step.decision === "declined") statuses[step.line] = "declined";
        break;
      case "paypal":
        checkout.push({ text: step.text, tone: step.final ? "ok" : "info" });
        if (step.final) {
          statuses[step.line] = getItem(ln.itemId).paypalFlow === "capture_now" ? "paid" : "held";
          amounts[step.line] = o.amountToPay ?? null;
        }
        break;
      case "after-payment":
        event = step.text;
        checkout.push({ text: `⚡ ${step.text}`, tone: "bad" });
        break;
      case "refund":
        checkout.push({ text: step.text, tone: "ok" });
        statuses[step.line] = "refunded";
        break;
      case "line-end":
        revealFloors = true;
        if (statuses[step.line] === "negotiating") statuses[step.line] = "no-deal";
        if (o.status !== "deal") checkout = [{ text: "No seller came under the walk-away price. No money moved.", tone: "info" }];
        break;
    }
  }

  let spentUsd = 0;
  let pendingUsd = 0;
  statuses.forEach((s, i) => {
    if (s === "paid" || s === "held") spentUsd += amounts[i] ?? 0;
    if (s === "awaiting-approval") pendingUsd += amounts[i] ?? 0;
  });

  return {
    line,
    plan: run.lines[line]?.deal.plan ?? null,
    offerIndex,
    booths,
    commentary,
    event,
    checkout,
    statuses,
    amounts,
    spentUsd,
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
      return Math.min(2400, 700 + b.text.length * 14);
    }
    case "guard":
      return 1400;
    case "paypal":
      return 1100;
    case "after-payment":
      return 1600;
    case "refund":
      return 1400;
    case "line-end":
      return 1800;
    default:
      return 600;
  }
}
