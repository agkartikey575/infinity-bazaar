// Runs a whole mission: every item's deal, each payment checked by AgentGuard.
// Assumes you approve every "ask you" payment; the deal room asks for real.
import { getItem, getMission } from "./data.ts";
import { planBuyer } from "./buyer.ts";
import { runDeal, type DealOptions } from "./deal.ts";
import { checkPayment, type GuardDecision, type GuardRules } from "./guard.ts";
import type { DealResult, Mission, SellerMemory } from "./types.ts";

export interface MissionLine {
  itemId: string;
  itemName: string;
  itemCapUsd: number;
  deal: DealResult;
  guard: GuardDecision | null;
  /** What happens to the money: paid, waiting for your OK, blocked, voided, or no deal. */
  status: "paid" | "needs-approval" | "blocked" | "voided" | "no-deal";
}

export interface MissionResult {
  missionId: string;
  seed: number;
  budgetUsd: number;
  spentUsd: number;
  pendingUsd: number;
  lines: MissionLine[];
  memory: SellerMemory;
}

export function missionRules(mission: Mission, itemCapUsd: number): GuardRules {
  return {
    budgetUsd: mission.budgetUsd,
    askAboveUsd: mission.askAboveUsd,
    itemCapUsd,
    reserveUsd: Math.round(mission.budgetUsd * mission.reserveShare),
    allowedGroups: mission.allowedGroups,
  };
}

/** The item's cap, never more than what is left of the budget. */
export function capFor(mission: Mission, itemCapUsd: number, committed: number): number {
  return Math.max(0, Math.min(itemCapUsd, mission.budgetUsd - committed));
}

/** "a USB microphone" → "the USB microphone". */
const theItem = (phrase: string) => phrase.replace(/^(an?|some) /i, "the ");
const usd = (n: number) => `$${n.toLocaleString("en-US")}`;

/**
 * One item under your own budget: the agent never plans past what's left,
 * counting every earlier deal as paid. Too little left to even open, and it
 * passes on the item; a walk-away the budget caused says so.
 */
function withinBudget(itemId: string, itemCapUsd: number, left: number, budgetUsd: number, opts: DealOptions): DealResult {
  const item = getItem(itemId);
  const cap = Math.max(0, Math.min(itemCapUsd, left));
  const deal = runDeal(itemId, { ...opts, itemCapUsd: cap });
  const skipLine = `Budget guard: the agent skips ${theItem(item.phrase)} to stay within your ${usd(budgetUsd)} budget.`;
  // Not enough left for even the opening offer, or (a safety net the engine never needs) a deal past what's left.
  const opening = planBuyer(item).anchor;
  if (cap < opening || (deal.outcome.status === "deal" && (deal.outcome.amountToPay ?? 0) > left)) {
    const sellers = deal.sellers.map((s) => ({ ...s, finalAsk: s.openAsk, active: true }));
    return {
      ...deal,
      sellers,
      beats: [
        { kind: "agent", round: 1, to: sellers.map((s) => s.id), move: "walk-away", text: `That would put me over your ${usd(budgetUsd)} budget, so I'll pass on this one.` },
        { kind: "commentary", round: 1, text: skipLine },
      ],
      outcome: { status: "walk-away", rounds: 1, fee: 0, futureFee: 0, levers: [], terms: [], afterPayment: null, budgetSkip: true },
      memory: structuredClone(opts.memory ?? {}),
    };
  }
  if (deal.outcome.status !== "deal" && cap < itemCapUsd) {
    const last = deal.beats.at(-1)?.round ?? 1;
    return { ...deal, beats: [...deal.beats, { kind: "commentary", round: last, text: skipLine }], outcome: { ...deal.outcome, budgetSkip: true } };
  }
  return deal;
}

export function runMission(
  missionId: string,
  opts: {
    seed?: number;
    memory?: SellerMemory;
    includeNice?: boolean;
    dealOptions?: Omit<DealOptions, "seed" | "itemCapUsd" | "memory">;
    /** Your own budget. The agent never plans past it: the run's deals together stay within it. */
    budgetUsd?: number;
  } = {},
): MissionResult {
  const mission = getMission(missionId);
  const seed = opts.seed ?? Math.floor(Math.random() * 2 ** 31);
  let memory = opts.memory ?? {};
  let spent = 0;
  let pending = 0;
  const lines: MissionLine[] = [];

  const items = mission.suggested.filter((s) => s.priority === "core" || opts.includeNice);
  /** With your own budget: what's left if every earlier deal is paid. */
  let left = opts.budgetUsd ?? Infinity;
  items.forEach((entry, i) => {
    const item = getItem(entry.item);
    const dealSeed = seed + i * 7919;
    let deal: DealResult;
    if (opts.budgetUsd === undefined) {
      deal = runDeal(entry.item, { ...opts.dealOptions, seed: dealSeed, itemCapUsd: capFor(mission, entry.itemCapUsd, spent + pending), memory });
    } else {
      deal = withinBudget(entry.item, entry.itemCapUsd, left, opts.budgetUsd, { ...opts.dealOptions, seed: dealSeed, memory });
      if (deal.outcome.status === "deal") left -= deal.outcome.amountToPay ?? 0;
    }
    memory = deal.memory;
    const o = deal.outcome;

    if (o.status !== "deal" || o.amountToPay === undefined || o.sellerId === undefined) {
      lines.push({ itemId: item.id, itemName: item.name, itemCapUsd: entry.itemCapUsd, deal, guard: null, status: "no-deal" });
      return;
    }
    const amount = o.amountToPay;
    const guard = checkPayment({
      amount,
      currency: "USD",
      spentSoFar: spent + pending,
      sellerId: o.sellerName ?? o.sellerId,
      sellerName: o.sellerName ?? "",
      group: item.group,
      alreadyPaid: false,
      agreedAmount: (o.price ?? 0) + o.fee,
      surpriseFee: o.surpriseFee,
      laterFee: o.futureFee,
      rules: missionRules(mission, entry.itemCapUsd),
    });
    let status: MissionLine["status"] = guard.decision === "approve" ? "paid" : guard.decision === "ask_user" ? "needs-approval" : "blocked";
    // A failed delivery voids the held payment, so that money is free again.
    if (status === "paid" && o.afterPayment) status = "voided";
    if (status === "paid") spent += amount;
    if (status === "needs-approval") pending += amount;
    lines.push({ itemId: item.id, itemName: item.name, itemCapUsd: entry.itemCapUsd, deal, guard, status });
  });

  return { missionId, seed, budgetUsd: mission.budgetUsd, spentUsd: spent, pendingUsd: pending, lines, memory };
}
