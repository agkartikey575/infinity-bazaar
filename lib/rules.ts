// Your rules: the budget and approval limit a person sets before playing.
// One set of checks for the deal room and the server, so both read the same limits.
import { getItem, getMission } from "../src/engine/index.ts";

export interface PlayerRules {
  budgetUsd: number;
  askAboveUsd: number;
}

export const BUDGET_MIN = 100;
export const BUDGET_MAX = 1000;
export const ASK_MIN = 25;
export const ASK_MAX = 300;

const fmt = (n: number) => `$${n.toLocaleString("en-US")}`;

/** Why these rules can't be used, or null when they are fine. */
export function rulesProblem(r: unknown): string | null {
  if (!r || typeof r !== "object") return "Rules must have a budget and an approval limit.";
  const { budgetUsd, askAboveUsd } = r as Record<string, unknown>;
  if (!Number.isInteger(budgetUsd) || !Number.isInteger(askAboveUsd)) return "Budget and approval limit must be whole dollars.";
  const b = budgetUsd as number;
  const a = askAboveUsd as number;
  if (b < BUDGET_MIN || b > BUDGET_MAX) return `Budget must be between ${fmt(BUDGET_MIN)} and ${fmt(BUDGET_MAX)}.`;
  if (a < ASK_MIN || a > ASK_MAX) return `Approval limit must be between ${fmt(ASK_MIN)} and ${fmt(ASK_MAX)}.`;
  if (a > b) return "Approval limit can't be above your budget.";
  return null;
}

/** Valid rules, or null. Extra fields are dropped. */
export function readRules(r: unknown): PlayerRules | null {
  if (rulesProblem(r)) return null;
  const { budgetUsd, askAboveUsd } = r as PlayerRules;
  return { budgetUsd, askAboveUsd };
}

/**
 * The nearest valid rules to what was typed, and a short note when something
 * had to change. Empty or unreadable values fall back to `fallback`.
 */
export function clampRules(budget: number, ask: number, fallback: PlayerRules): { rules: PlayerRules; note: string | null } {
  const notes: string[] = [];
  const whole = (n: number, keep: number) => (Number.isFinite(n) ? Math.round(n) : keep);
  let b = whole(budget, fallback.budgetUsd);
  let a = whole(ask, fallback.askAboveUsd);
  if ((Number.isFinite(budget) && b !== budget) || (Number.isFinite(ask) && a !== ask)) notes.push("Rounded to whole dollars");
  if (b < BUDGET_MIN || b > BUDGET_MAX) {
    b = Math.min(BUDGET_MAX, Math.max(BUDGET_MIN, b));
    notes.push(`Budget runs from ${fmt(BUDGET_MIN)} to ${fmt(BUDGET_MAX)}`);
  }
  if (a < ASK_MIN || a > ASK_MAX) {
    a = Math.min(ASK_MAX, Math.max(ASK_MIN, a));
    notes.push(`Approval limit runs from ${fmt(ASK_MIN)} to ${fmt(ASK_MAX)}`);
  }
  if (a > b) {
    a = b;
    notes.push("Approval limit can't be above your budget");
  }
  return { rules: { budgetUsd: b, askAboveUsd: a }, note: notes.length ? notes[notes.length - 1] : null };
}

/** Rules from a link's query (?budget=150&ask=60); anything invalid means none. */
export function rulesFromQuery(budget: string | null, ask: string | null): PlayerRules | null {
  if (budget === null || ask === null || !/^\d{1,4}$/.test(budget) || !/^\d{1,4}$/.test(ask)) return null;
  return readRules({ budgetUsd: Number(budget), askAboveUsd: Number(ask) });
}

export const sameRules = (a: PlayerRules | null | undefined, b: PlayerRules | null | undefined) =>
  (a?.budgetUsd ?? null) === (b?.budgetUsd ?? null) && (a?.askAboveUsd ?? null) === (b?.askAboveUsd ?? null);

/**
 * A one-line, honest forecast for the rules panel. Each item is expected to
 * cost its typical price, but never more than the limit set for it.
 */
export function rulesPreview(kind: "mission" | "single" | "rogue", id: string, rules: PlayerRules, itemCapUsd?: number): string {
  const ask = `anything over ${fmt(rules.askAboveUsd)} asks you first`;
  if (kind === "rogue") return `The agent is held to ${fmt(itemCapUsd ?? 0)} for this item, whatever it's told · ${ask}`;
  if (kind === "single") {
    const item = getItem(id);
    const likely = Math.min(item.price.typical, itemCapUsd ?? item.price.typical);
    return `${likely <= rules.budgetUsd ? `With ${fmt(rules.budgetUsd)}, your agent can likely afford it` : `${fmt(rules.budgetUsd)} is likely too little for this one`} · ${ask}`;
  }
  const mission = getMission(id);
  const items = mission.suggested.filter((s) => s.priority === "core");
  let left = rules.budgetUsd;
  let fits = 0;
  for (const s of items) {
    const likely = Math.min(getItem(s.item).price.typical, s.itemCapUsd);
    if (likely > left) continue;
    left -= likely;
    fits++;
  }
  return `With ${fmt(rules.budgetUsd)}, your agent can likely afford ${fits} of ${items.length} items · ${ask}`;
}
