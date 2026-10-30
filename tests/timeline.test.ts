// Invariants for lib/timeline.ts: every step of every run can be rendered,
// money never moves on blocked or declined payments, and the budget holds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { catalog, missions } from "../src/engine/index.ts";
import { buildMissionRun, buildSingleRun, buildSteps, deriveView, type Decision, type Run } from "../lib/timeline.ts";

const SEEDS = Array.from({ length: 40 }, (_, i) => i + 1);
const TERMINAL = new Set(["paid", "held", "declined", "blocked", "no-deal", "refunded"]);

function decisionSets(run: Run): Record<number, Decision>[] {
  const asks = run.lines.flatMap((l, i) => (l.guard?.decision === "ask_user" ? [i] : []));
  if (!asks.length) return [{}];
  return [
    Object.fromEntries(asks.map((i) => [i, "approved" as Decision])),
    Object.fromEntries(asks.map((i) => [i, "declined" as Decision])),
  ];
}

function checkRun(run: Run, tag: string) {
  for (const decisions of decisionSets(run)) {
    const { steps, waitingFor } = buildSteps(run, decisions);
    assert.equal(waitingFor, null, `${tag}: all approvals answered`);

    // No PayPal call or refund for a line that was blocked or declined.
    run.lines.forEach((l, i) => {
      const paid = l.guard?.decision === "approve" || (l.guard?.decision === "ask_user" && decisions[i] === "approved");
      const money = steps.filter((s) => s.line === i && (s.type === "paypal" || s.type === "refund" || s.type === "after-payment"));
      if (!paid) assert.equal(money.length, 0, `${tag} line ${i}: money moved without approval`);
      if (l.deal.outcome.rogue) assert.equal(money.length, 0, `${tag} line ${i}: rogue payment reached PayPal`);
    });

    let prev: ReturnType<typeof deriveView> | null = null;
    for (let c = 0; c <= steps.length; c++) {
      const v = deriveView(run, steps, c);
      assert.ok(Number.isFinite(v.spentUsd) && Number.isFinite(v.pendingUsd), `${tag}@${c}: finite money`);
      assert.ok(v.spentUsd + v.pendingUsd <= run.budgetUsd, `${tag}@${c}: spent + pending within budget`);
      for (const r of v.checkout) assert.doesNotMatch(r.text, /undefined|NaN/, `${tag}@${c}`);
      for (const b of v.booths) assert.ok(Number.isFinite(b.price), `${tag}@${c}: booth price`);
      if (prev) {
        prev.statuses.forEach((s, i) => {
          // Once a line is settled it only changes from paid/held to refunded.
          if (TERMINAL.has(s) && s !== "paid" && s !== "held") assert.equal(v.statuses[i], s, `${tag}@${c} line ${i}`);
        });
      }
      prev = v;
    }
    const end = deriveView(run, steps, steps.length);
    for (const s of end.statuses) assert.ok(TERMINAL.has(s), `${tag}: line ends settled, got ${s}`);
    assert.ok(end.revealFloors, `${tag}: floors revealed at the end`);
  }
}

test("timeline: every mission and seed renders every step consistently", () => {
  for (const m of missions) for (const seed of SEEDS) checkRun(buildMissionRun(m.id, seed), `${m.id}#${seed}`);
});

test("timeline: every catalog item renders every step consistently", () => {
  for (const item of catalog.items) for (const seed of SEEDS.slice(0, 15)) checkRun(buildSingleRun(item.id, seed), `${item.id}#${seed}`);
});

test("timeline: the rogue demo is always blocked and never reaches PayPal", () => {
  for (let seed = 1; seed <= 300; seed++) {
    const run = buildSingleRun("usb-mic", seed, true);
    const line = run.lines[0];
    assert.equal(line.deal.outcome.rogue, true, `seed ${seed}: agent falls for the upsell`);
    assert.equal(line.guard?.decision, "block", `seed ${seed}: AgentGuard blocks`);
    const { steps } = buildSteps(run, {});
    assert.equal(steps.filter((s) => s.type === "paypal").length, 0, `seed ${seed}`);
    assert.equal(deriveView(run, steps, steps.length).statuses[0], "blocked");
  }
});

test("timeline: a declined approval moves no money and frees the pending amount", () => {
  const run = buildMissionRun("hackathon-10-days", 7);
  const i = run.lines.findIndex((l) => l.guard?.decision === "ask_user");
  assert.ok(i >= 0, "seed 7 needs an approval");
  const waiting = buildSteps(run, {});
  assert.equal(waiting.waitingFor, i);
  const atAsk = deriveView(run, waiting.steps, waiting.steps.length);
  assert.equal(atAsk.statuses[i], "awaiting-approval");
  assert.equal(atAsk.pendingUsd, run.lines[i].deal.outcome.amountToPay);

  const { steps } = buildSteps(run, { [i]: "declined" });
  const end = deriveView(run, steps, steps.length);
  assert.equal(end.statuses[i], "declined");
  assert.equal(end.pendingUsd, 0);
  const paid = run.lines.reduce((sum, l, k) => sum + (k !== i && l.guard?.decision === "approve" ? l.deal.outcome.amountToPay ?? 0 : 0), 0);
  assert.equal(end.spentUsd, paid);
});
