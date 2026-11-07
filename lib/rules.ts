// Your rules: the budget and approval limit a person sets before playing.
// One set of checks for the deal room and the server, so both read the same limits.
import { buildMissionRun, buildSingleRun, buildSteps, deriveView, type Decision, type Run } from "./timeline.ts";

export interface PlayerRules {
  budgetUsd: number;
  askAboveUsd: number;
}

export const BUDGET_MIN = 100;
export const BUDGET_MAX = 1000;
export const ASK_MIN = 25;
export const ASK_MAX = 300;

/** Dollars with thousands commas: "$1,000", "$19.99". */
export const fmt = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;

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

const DOLLARS = /^(\d+(\.\d*)?|\.\d+)$/;

/** A typed dollar amount: a number, NaN when empty, or null when it isn't a number at all. */
export function parseDollars(text: string): number | null {
  const t = text.trim().replace(/^[$]/, "").replace(/,/g, "");
  if (t === "") return NaN;
  return DOLLARS.test(t) ? Number(t) : null;
}

export const WHOLE_DOLLARS_NOTE = "Use whole dollars, like 150";

/** clampRules for what was typed: decimals are rounded; letters keep the rules in force, with a note. */
export function clampDraft(budget: string, ask: string, fallback: PlayerRules): { rules: PlayerRules; note: string | null } {
  const b = parseDollars(budget);
  const a = parseDollars(ask);
  const c = clampRules(b ?? NaN, a ?? NaN, fallback);
  return b === null || a === null ? { rules: c.rules, note: WHOLE_DOLLARS_NOTE } : c;
}

/** Rules from a link's query (?budget=150&ask=60); anything invalid means none. */
export function rulesFromQuery(budget: string | null, ask: string | null): PlayerRules | null {
  if (budget === null || ask === null || !/^\d{1,4}$/.test(budget) || !/^\d{1,4}$/.test(ask)) return null;
  return readRules({ budgetUsd: Number(budget), askAboveUsd: Number(ask) });
}

export const sameRules = (a: PlayerRules | null | undefined, b: PlayerRules | null | undefined) =>
  (a?.budgetUsd ?? null) === (b?.budgetUsd ?? null) && (a?.askAboveUsd ?? null) === (b?.askAboveUsd ?? null);

/** How many deals the preview plays: deal numbers 1 to 25. */
export const PREVIEW_DEALS = 25;

/** Items paid at the end of a run when every "ask you" is approved. */
export function paidCount(run: Run): number {
  const decisions: Record<number, Decision> = {};
  for (;;) {
    const r = buildSteps(run, decisions);
    if (r.waitingFor === null) return deriveView(run, r.steps, r.steps.length).statuses.filter((x) => x === "captured").length;
    decisions[r.waitingFor] = "approved";
  }
}

/**
 * A one-line, honest forecast for the rules panel, from the engine itself: the
 * same deterministic deals the room plays, for deal numbers 1–25, approving
 * whatever asks you first. "Usually" is the middle result (the median).
 */
export function rulesPreview(kind: "mission" | "single" | "rogue", id: string, rules: PlayerRules): string {
  const ask = `anything over ${fmt(rules.askAboveUsd)} asks you first`;
  if (kind === "rogue") return `The agent is held to $70 for this item, whatever it's told · ${ask}`;
  const counts: number[] = [];
  const skips: number[] = [];
  let total = 0;
  for (let seed = 1; seed <= PREVIEW_DEALS; seed++) {
    const run = kind === "mission" ? buildMissionRun(id, seed, rules) : buildSingleRun(id, seed, false, rules);
    total = run.lines.length;
    counts.push(paidCount(run));
    skips.push(run.lines.filter((l) => l.deal.outcome.budgetSkip).length);
  }
  const usual = median(counts);
  if (kind === "single") return `With ${fmt(rules.budgetUsd)}, your agent usually ${usual ? "gets it" : "can't get it"} · ${ask}`;
  const buys = usual === total ? `usually buys all ${total} items` : `usually buys ${usual} of ${total} items`;
  const skipNote = median(skips) > 0 ? " and skips the rest to stay in budget" : "";
  return `With ${fmt(rules.budgetUsd)}, your agent ${buys}${skipNote} · ${ask}`;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
