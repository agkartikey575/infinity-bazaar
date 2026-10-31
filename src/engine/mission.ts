// Runs a whole mission: every item's deal, each payment checked by AgentGuard.
// Assumes you approve every "ask you" payment; the deal room asks for real.
import { getItem, getMission } from "./data.ts";
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

export function runMission(
  missionId: string,
  opts: { seed?: number; memory?: SellerMemory; includeNice?: boolean; dealOptions?: Omit<DealOptions, "seed" | "itemCapUsd" | "memory"> } = {},
): MissionResult {
  const mission = getMission(missionId);
  const seed = opts.seed ?? Math.floor(Math.random() * 2 ** 31);
  let memory = opts.memory ?? {};
  let spent = 0;
  let pending = 0;
  const lines: MissionLine[] = [];

  const items = mission.suggested.filter((s) => s.priority === "core" || opts.includeNice);
  items.forEach((entry, i) => {
    const item = getItem(entry.item);
    const cap = capFor(mission, entry.itemCapUsd, spent + pending);
    const deal = runDeal(entry.item, { ...opts.dealOptions, seed: seed + i * 7919, itemCapUsd: cap, memory });
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
