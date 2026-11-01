// Invariants for lib/timeline.ts: every step of every run can be rendered,
// money never moves on blocked or declined payments, and the budget holds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { catalog, missions } from "../src/engine/index.ts";
import { buildMissionRun, buildSingleRun, buildSteps, deriveView, stepDelay, type Decision, type Run, type Step } from "../lib/timeline.ts";

const SEEDS = Array.from({ length: 40 }, (_, i) => i + 1);
const TERMINAL = new Set(["captured", "declined", "blocked", "no-deal", "voided"]);

/** Plays a run to the end, answering every approval the same way. */
function playAll(run: Run, answer: Decision) {
  const decisions: Record<number, Decision> = {};
  for (;;) {
    const r = buildSteps(run, decisions);
    if (r.waitingFor === null) return { ...r, decisions };
    decisions[r.waitingFor] = answer;
  }
}

const guardOf = (steps: Step[], line: number) => steps.find((s): s is Extract<Step, { type: "guard" }> => s.type === "guard" && s.line === line)?.guard;

function checkRun(run: Run, tag: string) {
  for (const answer of ["approved", "declined"] as Decision[]) {
    const { steps, decisions } = playAll(run, answer);

    // No PayPal call for a line that was blocked or declined; rogue never reaches PayPal.
    run.lines.forEach((l, i) => {
      const g = guardOf(steps, i);
      const paid = g?.decision === "approve" || (g?.decision === "ask_user" && decisions[i] === "approved");
      const money = steps.filter((s) => s.line === i && s.type === "paypal");
      if (!paid) assert.equal(money.length, 0, `${tag} line ${i}: money moved without approval`);
      if (l.deal.outcome.rogue) assert.equal(money.length, 0, `${tag} line ${i}: rogue payment reached PayPal`);
    });

    let prev: ReturnType<typeof deriveView> | null = null;
    for (let c = 0; c <= steps.length; c++) {
      const v = deriveView(run, steps, c);
      assert.ok(Number.isFinite(v.committedUsd) && Number.isFinite(v.pendingUsd), `${tag}@${c}: finite money`);
      assert.ok(v.committedUsd + v.pendingUsd <= run.budgetUsd, `${tag}@${c}: committed + pending within budget`);
      assert.ok(v.capturedUsd <= v.committedUsd, `${tag}@${c}: captured is part of committed`);
      for (const r of v.checkout) assert.doesNotMatch(r.text, /undefined|NaN/, `${tag}@${c}`);
      for (const b of v.booths) assert.ok(Number.isFinite(b.price), `${tag}@${c}: booth price`);
      if (prev) {
        prev.statuses.forEach((s, i) => {
          // Settled lines stay settled.
          if (TERMINAL.has(s)) assert.equal(v.statuses[i], s, `${tag}@${c} line ${i}`);
        });
      }
      prev = v;
    }
    const end = deriveView(run, steps, steps.length);
    for (const s of end.statuses) assert.ok(TERMINAL.has(s), `${tag}: line ends settled, got ${s}`);
    assert.ok(end.revealFloors, `${tag}: floors revealed at the end`);

    // AgentGuard's running total matches the money actually committed before each line.
    let committed = 0;
    run.lines.forEach((l, i) => {
      const g = guardOf(steps, i);
      if (g) {
        const label = g.checks.find((c) => c.label.startsWith("Total stays"))?.label ?? "";
        const amount = l.deal.outcome.amountToPay ?? 0;
        assert.equal(Number(label.match(/\(\$([\d.]+)\)$/)?.[1]), committed + amount, `${tag} line ${i}: "${label}" vs committed ${committed}`);
      }
      if (end.statuses[i] === "captured") committed += l.deal.outcome.amountToPay ?? 0;
    });
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
    assert.equal(run.lines[0].deal.outcome.rogue, true, `seed ${seed}: agent falls for the upsell`);
    const { steps } = buildSteps(run, {});
    assert.equal(guardOf(steps, 0)?.decision, "block", `seed ${seed}: AgentGuard blocks`);
    assert.equal(steps.filter((s) => s.type === "paypal").length, 0, `seed ${seed}`);
    const end = deriveView(run, steps, steps.length);
    assert.equal(end.statuses[0], "blocked");
    assert.notEqual(end.booths.find((b) => b.id === run.lines[0].deal.outcome.sellerId)?.state, "won", "blocked seller is not shown as the winner");
  }
});

test("timeline: a declined approval moves no money and frees the pending amount", () => {
  let found = 0;
  for (const seed of SEEDS) {
    const run = buildMissionRun("hackathon-10-days", seed);
    const waiting = buildSteps(run, {});
    if (waiting.waitingFor === null) continue;
    found++;
    const i = waiting.waitingFor;
    const atAsk = deriveView(run, waiting.steps, waiting.steps.length);
    assert.equal(atAsk.statuses[i], "awaiting-approval");
    assert.equal(atAsk.pendingUsd, run.lines[i].deal.outcome.amountToPay);

    const { steps } = playAll(run, "declined");
    const end = deriveView(run, steps, steps.length);
    assert.equal(end.statuses[i], "declined");
    assert.equal(end.pendingUsd, 0);
    assert.equal(end.amounts[i], null, "a declined line shows no amount");
  }
  assert.ok(found > 0, "some seed needs an approval");
});

test("timeline: a failed delivery voids the hold and frees the money", () => {
  let found = 0;
  for (const item of catalog.items.filter((x) => x.paypalFlow !== "capture_now")) {
    for (const seed of SEEDS) {
      const run = buildSingleRun(item.id, seed);
      if (!run.lines[0].deal.outcome.afterPayment) continue;
      const { steps } = playAll(run, "approved");
      const end = deriveView(run, steps, steps.length);
      if (end.statuses[0] === "blocked" || end.statuses[0] === "no-deal") continue;
      found++;
      assert.equal(end.statuses[0], "voided", `${item.id}#${seed}`);
      assert.equal(end.committedUsd, 0);
      assert.ok(steps.some((s) => s.type === "paypal" && s.detail.includes("/void")), `${item.id}#${seed}: void call shown`);
    }
  }
  assert.ok(found > 0, "some deal has a failed delivery");
});

test("timeline: held payments are captured only after delivery", () => {
  for (const seed of SEEDS) {
    const run = buildSingleRun("usb-mic", seed);
    const { steps } = playAll(run, "approved");
    const pp = steps.filter((s): s is Extract<Step, { type: "paypal" }> => s.type === "paypal");
    if (!pp.length) continue;
    const auth = pp.findIndex((s) => s.effect === "authorized");
    const cap = pp.findIndex((s) => s.effect === "captured");
    assert.ok(auth >= 0, `seed ${seed}: shipped item is authorized first`);
    if (cap >= 0) assert.ok(cap > auth && pp[cap].detail.includes("/authorizations/"), `seed ${seed}: capture follows the hold`);
  }
});

test("a commentary line is held for reading only when another commentary line follows", () => {
  const line = (text: string): Step => ({ type: "beat", line: 0, beat: { kind: "commentary", round: 1, text } });
  const chat: Step = { type: "beat", line: 0, beat: { kind: "seller", round: 1, sellerId: "s1", move: "counter", price: 50, text: "Fifty, final." } };
  const text = "Price war! Madame Vex goes to $53.";
  assert.equal(stepDelay(line(text)), 1200, "no next step: short beat");
  assert.equal(stepDelay(line(text), chat), 1200, "chat next: plays over the chat");
  assert.equal(stepDelay(line(text), line("Next.")), Math.min(4500, Math.max(2200, 1600 + 32 * text.length)), "commentary next: reading time");
});

test("booth messages are numbered in arrival order and fees count in the all-in offer", () => {
  for (const seed of SEEDS.slice(0, 10)) {
    const run = buildMissionRun("hackathon-10-days", seed);
    const { steps } = buildSteps(run, {});
    const v = deriveView(run, steps, steps.length);
    const seqs = v.booths.flatMap((b) => b.messages.map((m) => m.seq));
    assert.equal(new Set(seqs).size, seqs.length, "every message has its own number");
    for (const b of v.booths) {
      assert.equal(b.lastSeq, b.messages.at(-1)?.seq ?? 0);
      if (b.offer !== null) assert.ok(b.offerAllIn !== null && b.offerAllIn >= b.offer);
    }
  }
});
