// Runs a whole mission: every item's deal, each payment checked by AgentGuard.
import { getItem, getMission } from "./data.ts";
import { runDeal, type DealOptions } from "./deal.ts";
import { checkPayment, type GuardDecision } from "./guard.ts";
import type { DealResult, SellerMemory } from "./types.ts";

export interface MissionLine {
  itemId: string;
  itemName: string;
  itemCapUsd: number;
  deal: DealResult;
  guard: GuardDecision | null;
  /** What happens to the money: paid, waiting for your OK, blocked, or no deal. */
  status: "paid" | "needs-approval" | "blocked" | "no-deal";
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
    const deal = runDeal(entry.item, { ...opts.dealOptions, seed: seed + i * 7919, itemCapUsd: entry.itemCapUsd, memory });
    memory = deal.memory;

    if (deal.outcome.status !== "deal" || deal.outcome.price === undefined) {
      lines.push({ itemId: item.id, itemName: item.name, itemCapUsd: entry.itemCapUsd, deal, guard: null, status: "no-deal" });
      return;
    }
    const amount = deal.outcome.amountToPay ?? deal.outcome.price;
    const guard = checkPayment({
      amount,
      spentSoFar: spent + pending,
      sellerName: deal.outcome.sellerName ?? "",
      rules: { budgetUsd: mission.budgetUsd, askAboveUsd: mission.askAboveUsd, itemCapUsd: entry.itemCapUsd },
    });
    const status = guard.decision === "approve" ? "paid" : guard.decision === "ask_user" ? "needs-approval" : "blocked";
    if (status === "paid") spent += amount;
    if (status === "needs-approval") pending += amount;
    lines.push({ itemId: item.id, itemName: item.name, itemCapUsd: entry.itemCapUsd, deal, guard, status });
  });

  return { missionId, seed, budgetUsd: mission.budgetUsd, spentUsd: spent, pendingUsd: pending, lines, memory };
}
