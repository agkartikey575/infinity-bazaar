// Your rules: the budget and approval limit you set hold on screen, in AgentGuard
// on the server, and in the signed ledger, and change nothing when left unset.
import { test } from "node:test";
import assert from "node:assert/strict";
import { clampRules, readRules, rulesFromQuery, rulesPreview, rulesProblem, sameRules } from "../lib/rules.ts";
import { buildMissionRun, buildSingleRun, buildSteps, deriveView, type Decision, type Run } from "../lib/timeline.ts";
import { declineLine, deliver, earlierSettled, guardLine, pay, rebuildRun } from "../lib/server/agent.ts";
import { emptyLedger, readLedger, signLedger, transition, type Ledger, type RunRef } from "../lib/server/ledger.ts";
import { HttpError, readRunRef } from "../lib/server/request.ts";
import { getMission, missionRules } from "../src/engine/index.ts";

const SECRET = "test-secret";
const MISSION = "hackathon-10-days";
const ref = (seed: number, rules?: { budgetUsd: number; askAboveUsd: number }, nonce = "rulesnonce1"): RunRef => ({ kind: "mission", id: MISSION, seed, nonce, ...(rules ? { rules } : {}) });
const deals = (run: Run) => run.lines.map((l) => l.deal);

/** What the screen ends on, answering every approval the same way. */
function screen(run: Run, answer: Decision = "approved") {
  const decisions: Record<number, Decision> = {};
  for (;;) {
    const r = buildSteps(run, decisions);
    if (r.waitingFor === null) return deriveView(run, r.steps, r.steps.length).statuses;
    decisions[r.waitingFor] = answer;
  }
}

/** The server's own verdicts, paying line by line in demo mode the way the deal room does. */
async function server(r: RunRef, answer: Decision = "approved") {
  const ctx = { paypal: null, vaultId: null, returnUrl: "http://localhost/paypal/return" };
  const run = rebuildRun(r);
  let ledger: Ledger = emptyLedger(r);
  const out: string[] = [];
  for (let i = 0; i < run.lines.length; i++) {
    if (run.lines[i].deal.outcome.status !== "deal") {
      out.push("no-deal");
      continue;
    }
    let res = await pay(r, i, ledger, false, ctx);
    if (res.decision === "ask_user") {
      if (answer === "declined") {
        ledger = declineLine(r, i, res.ledger);
        out.push("declined");
        continue;
      }
      res = await pay(r, i, res.ledger, true, ctx);
    }
    ledger = res.ledger;
    if (res.decision === "block") out.push("blocked");
    else if (res.decision === "paid" && res.state === "authorized") {
      const d = await deliver(r, i, ledger, null);
      ledger = d.ledger;
      out.push(d.state);
    } else if (res.decision === "paid") out.push(res.state);
    else out.push(res.decision);
  }
  return out;
}

test("validation: whole dollars, budget $100–$1,000, approval limit $25–$300 and never above the budget", () => {
  assert.equal(rulesProblem({ budgetUsd: 150, askAboveUsd: 60 }), null);
  assert.equal(rulesProblem({ budgetUsd: 100, askAboveUsd: 25 }), null);
  assert.equal(rulesProblem({ budgetUsd: 1000, askAboveUsd: 300 }), null);
  assert.equal(rulesProblem({ budgetUsd: 100, askAboveUsd: 100 }), null, "equal to the budget is fine");
  assert.match(rulesProblem({ budgetUsd: 150.5, askAboveUsd: 60 })!, /whole dollars/);
  assert.match(rulesProblem({ budgetUsd: "150", askAboveUsd: 60 })!, /whole dollars/);
  assert.match(rulesProblem({ budgetUsd: 99, askAboveUsd: 60 })!, /Budget must be between \$100 and \$1,000/);
  assert.match(rulesProblem({ budgetUsd: 1001, askAboveUsd: 60 })!, /Budget/);
  assert.match(rulesProblem({ budgetUsd: 150, askAboveUsd: 24 })!, /Approval limit must be between \$25 and \$300/);
  assert.match(rulesProblem({ budgetUsd: 500, askAboveUsd: 301 })!, /Approval limit/);
  assert.match(rulesProblem({ budgetUsd: 120, askAboveUsd: 150 })!, /Approval limit can't be above your budget/);
  assert.ok(rulesProblem(null));
  assert.ok(rulesProblem({ budgetUsd: NaN, askAboveUsd: 60 }));
  assert.deepEqual(readRules({ budgetUsd: 150, askAboveUsd: 60, extra: 1 }), { budgetUsd: 150, askAboveUsd: 60 });
  assert.equal(readRules({ budgetUsd: 50, askAboveUsd: 60 }), null);
});

test("validation in the deal room: values are clamped with a short note", () => {
  const fallback = { budgetUsd: 300, askAboveUsd: 100 };
  assert.deepEqual(clampRules(150, 60, fallback), { rules: { budgetUsd: 150, askAboveUsd: 60 }, note: null });
  assert.deepEqual(clampRules(120, 200, fallback), { rules: { budgetUsd: 120, askAboveUsd: 120 }, note: "Approval limit can't be above your budget" });
  assert.deepEqual(clampRules(5000, 100, fallback).rules, { budgetUsd: 1000, askAboveUsd: 100 });
  assert.match(clampRules(5000, 100, fallback).note!, /Budget runs from \$100 to \$1,000/);
  assert.deepEqual(clampRules(20, 10, fallback).rules, { budgetUsd: 100, askAboveUsd: 25 });
  assert.deepEqual(clampRules(150.4, 60, fallback), { rules: { budgetUsd: 150, askAboveUsd: 60 }, note: "Rounded to whole dollars" });
  assert.deepEqual(clampRules(NaN, NaN, fallback), { rules: fallback, note: null }, "empty fields keep the rules in force");
  // Whatever the deal room sends after clamping, the server accepts.
  for (const [b, a] of [[0, 0], [99999, 99999], [123.7, 400], [250, 3]]) assert.equal(rulesProblem(clampRules(b, a, fallback).rules), null);
});

test("shared links: valid rules are read, anything else falls back to none", () => {
  assert.deepEqual(rulesFromQuery("150", "60"), { budgetUsd: 150, askAboveUsd: 60 });
  for (const [b, a] of [[null, "60"], ["150", null], ["abc", "60"], ["150", "-5"], ["150.5", "60"], ["50", "40"], ["120", "200"], ["1e3", "60"], ["", ""]] as const) {
    assert.equal(rulesFromQuery(b, a), null, `${b}/${a}`);
  }
});

test("the server rejects bad rules with 400 and a clear message, and binds good ones into the run", () => {
  const base = { kind: "mission", id: MISSION, seed: 42, nonce: "rulesnonce1" };
  const bad = (rules: unknown) => {
    try {
      readRunRef({ ...base, rules });
    } catch (e) {
      assert.ok(e instanceof HttpError);
      assert.equal(e.status, 400);
      return e.message;
    }
    assert.fail(`accepted ${JSON.stringify(rules)}`);
  };
  assert.match(bad({ budgetUsd: 120, askAboveUsd: 150 }), /^Invalid rules\. Approval limit can't be above your budget\.$/);
  assert.match(bad({ budgetUsd: 50, askAboveUsd: 40 }), /Budget must be between/);
  assert.match(bad({ budgetUsd: 150, askAboveUsd: 10 }), /Approval limit must be between/);
  assert.match(bad({ budgetUsd: 150.5, askAboveUsd: 60 }), /whole dollars/);
  assert.match(bad({ budgetUsd: "150", askAboveUsd: "60" }), /whole dollars/);
  assert.match(bad("150/60"), /budget and an approval limit/);
  assert.deepEqual(readRunRef({ ...base, rules: { budgetUsd: 150, askAboveUsd: 60, reserveUsd: 0 } }).rules, { budgetUsd: 150, askAboveUsd: 60 }, "only budget and limit are kept");
  assert.equal("rules" in readRunRef(base), false, "no rules: the run is named exactly as before");
  assert.equal("rules" in readRunRef({ ...base, rules: null }), false);
});

test("rebuildRun with rules: your budget and limit, a scaled reserve, capped item limits, the same deals", () => {
  const mission = getMission(MISSION);
  const plain = rebuildRun(ref(42));
  const run = rebuildRun(ref(42, { budgetUsd: 150, askAboveUsd: 60 }));
  assert.deepEqual(deals(run), deals(plain), "same deal number, same deals");
  assert.equal(run.budgetUsd, 150);
  assert.equal(run.askAboveUsd, 60);
  assert.match(run.goal, /Budget \$150\./);
  for (const l of run.lines) {
    assert.equal(l.rules.budgetUsd, 150);
    assert.equal(l.rules.askAboveUsd, 60);
    assert.equal(l.rules.reserveUsd, Math.round(missionRules(mission, l.itemCapUsd).reserveUsd! * (150 / mission.budgetUsd)));
    assert.equal(l.rules.itemCapUsd, Math.min(l.itemCapUsd, 150));
    assert.deepEqual(l.rules.allowedGroups, mission.allowedGroups);
  }
  // An item limit above the budget comes down to the budget.
  const launch = buildMissionRun("launch-week", 7, { budgetUsd: 120, askAboveUsd: 50 });
  const copy = launch.lines.find((l) => l.itemId === "copywriter")!;
  assert.equal(copy.itemCapUsd, 200);
  assert.equal(copy.rules.itemCapUsd, 120);
  // Single items have no reserve, and keep none.
  const single = buildSingleRun("webcam", 3, false, { budgetUsd: 200, askAboveUsd: 30 });
  assert.equal(single.lines[0].rules.reserveUsd, undefined);
  assert.equal(single.lines[0].rules.askAboveUsd, 30);
  assert.deepEqual(deals(single), deals(buildSingleRun("webcam", 3)));
});

test("rogue mode keeps its $70 limit and is still blocked under any rules", () => {
  for (const rules of [undefined, { budgetUsd: 100, askAboveUsd: 25 }, { budgetUsd: 1000, askAboveUsd: 300 }]) {
    const run = rebuildRun({ kind: "rogue", id: "usb-mic", seed: 42, nonce: "rulesnonce1", ...(rules ? { rules } : {}) });
    assert.equal(run.lines[0].rules.itemCapUsd, 70);
    assert.deepEqual(screen(run), ["blocked"]);
    assert.equal(guardLine(run, 0, emptyLedger(ref(42))).guard.decision, "block");
  }
});

test("AgentGuard follows your budget: a low budget blocks the third item", () => {
  let found = 0;
  for (let seed = 1; seed <= 200 && found < 5; seed++) {
    const plain = buildMissionRun(MISSION, seed);
    // Three deals, the first two paid in full (a failed delivery would free its money).
    if (!plain.lines.every((l) => l.deal.outcome.status === "deal")) continue;
    if (screen(plain).slice(0, 2).some((s) => s !== "captured")) continue;
    const [a, b, c] = plain.lines.map((l) => l.deal.outcome.amountToPay!);
    // Enough for the first two, not the third; a high approval limit so nothing waits on you.
    const budget = Math.ceil(a + b);
    if (budget < 100 || budget >= a + b + c || budget > 1000) continue;
    const rules = { budgetUsd: budget, askAboveUsd: Math.min(300, budget) };
    const run = buildMissionRun(MISSION, seed, rules);
    const s = screen(run);
    assert.equal(s[2], "blocked", `deal ${seed}: third item blocked at $${budget}`);
    assert.notEqual(screen(plain)[2], "blocked", `deal ${seed}: not blocked with the mission's own budget`);
    found++;
  }
  assert.ok(found >= 3, `found enough deals: ${found}`);
});

test("AgentGuard follows your approval limit: a low limit asks you first", () => {
  let found = 0;
  for (let seed = 1; seed <= 100; seed++) {
    const plain = buildMissionRun(MISSION, seed);
    const first = plain.lines[0].deal.outcome;
    if (first.status !== "deal" || first.amountToPay! <= 25) continue;
    if (guardLine(plain, 0, emptyLedger(ref(seed))).guard.decision !== "approve") continue;
    const r = ref(seed, { budgetUsd: 300, askAboveUsd: 25 });
    const g = guardLine(rebuildRun(r), 0, emptyLedger(r)).guard;
    assert.equal(g.decision, "ask_user");
    assert.match(g.summary, /over your \$25 approval limit/);
    assert.equal(buildSteps(rebuildRun(r), {}).waitingFor, 0, "the screen asks you too");
    found++;
  }
  assert.ok(found >= 3, `found enough deals: ${found}`);
});

test("the ledger is bound to the rules: one signed for other rules is rejected", () => {
  const a = ref(42, { budgetUsd: 150, askAboveUsd: 60 });
  const token = signLedger(transition(emptyLedger(a), 0, { state: "declined", amountCents: 100 }), SECRET);
  assert.ok(readLedger(token, a, SECRET), "same rules: accepted");
  assert.equal(readLedger(token, ref(42, { budgetUsd: 1000, askAboveUsd: 60 }), SECRET), null, "a bigger budget");
  assert.equal(readLedger(token, ref(42, { budgetUsd: 150, askAboveUsd: 300 }), SECRET), null, "a higher limit");
  assert.equal(readLedger(token, ref(42), SECRET), null, "no rules");
  const plain = signLedger(emptyLedger(ref(42)), SECRET);
  assert.equal(readLedger(plain, a, SECRET), null, "a default ledger can't be used under your rules");
  assert.ok(readLedger(plain, ref(42), SECRET));
});

test("no rules: runs, AgentGuard and the ledger are exactly as before", () => {
  for (const m of ["hackathon-10-days", "launch-week", "home-studio"]) {
    const mission = getMission(m);
    for (const seed of [1, 7, 42, 99]) {
      const run = buildMissionRun(m, seed);
      assert.equal(run.goal, mission.goal);
      assert.equal(run.budgetUsd, mission.budgetUsd);
      assert.equal(run.askAboveUsd, mission.askAboveUsd);
      for (const l of run.lines) assert.deepEqual(l.rules, missionRules(mission, l.itemCapUsd));
      // The mission's own numbers, sent as rules, give the same verdicts.
      const same = buildMissionRun(m, seed, { budgetUsd: mission.budgetUsd, askAboveUsd: mission.askAboveUsd });
      assert.deepEqual(screen(same), screen(run));
    }
  }
  const single = buildSingleRun("usb-mic", 42);
  assert.deepEqual(single.lines[0].rules, { budgetUsd: 300, askAboveUsd: 100, itemCapUsd: 70 });
  assert.equal(single.budgetUsd, 300);
  // The signed ledger reads the same as before: no rules field at all.
  const token = signLedger(emptyLedger(ref(42)), SECRET);
  assert.doesNotMatch(Buffer.from(token.split(".")[0], "base64url").toString(), /"rules"/);
  assert.ok(sameRules(undefined, null));
});

test("the server agrees with the screen under your rules, deal after deal", async () => {
  let checked = 0;
  for (const rules of [{ budgetUsd: 120, askAboveUsd: 40 }, { budgetUsd: 140, askAboveUsd: 100 }, { budgetUsd: 100, askAboveUsd: 25 }, { budgetUsd: 600, askAboveUsd: 30 }]) {
    for (const seed of [1, 7, 42, 99, 123]) {
      for (const answer of ["approved", "declined"] as const) {
        const r = ref(seed, rules);
        assert.deepEqual(await server(r, answer), screen(rebuildRun(r), answer), `deal ${seed} at $${rules.budgetUsd}/$${rules.askAboveUsd}, ${answer}`);
        checked++;
      }
    }
  }
  assert.equal(checked, 40);
});

test("when the deals cost more than your budget, the server takes items in order", async () => {
  const ctx = { paypal: null, vaultId: null, returnUrl: "http://localhost/paypal/return" };
  for (let seed = 1; seed < 200; seed++) {
    const r = ref(seed, { budgetUsd: 100, askAboveUsd: 100 });
    const run = rebuildRun(r);
    if (!run.lines.every((l) => l.deal.outcome.status === "deal")) continue;
    // Skipping ahead is refused, so a later item can't take money an earlier one is owed.
    await assert.rejects(pay(r, 2, emptyLedger(r), true, ctx), /has to wait until the items before it are settled/);
    assert.throws(() => declineLine(r, 1, emptyLedger(r)), /has to wait/);
    assert.equal(earlierSettled(run, 0, emptyLedger(r)), true);
    return;
  }
  assert.fail("no deal with three items");
});

test("the rules preview is plain and honest", () => {
  assert.match(rulesPreview("mission", MISSION, { budgetUsd: 300, askAboveUsd: 100 }), /^With \$300, your agent can likely afford 3 of 3 items · anything over \$100 asks you first$/);
  assert.match(rulesPreview("mission", MISSION, { budgetUsd: 100, askAboveUsd: 40 }), /afford [12] of 3 items · anything over \$40 asks you first/);
  assert.match(rulesPreview("single", "usb-mic", { budgetUsd: 300, askAboveUsd: 100 }, 70), /can likely afford it/);
  assert.match(rulesPreview("rogue", "usb-mic", { budgetUsd: 300, askAboveUsd: 100 }, 70), /held to \$70/);
});
