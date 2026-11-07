// Your rules: the budget and approval limit you set hold on screen, in AgentGuard
// on the server, and in the signed ledger, and change nothing when left unset.
// With your rules the engine never plans past the budget, so even replayed
// ledgers can't take spending past it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { clampDraft, clampRules, fmt, paidCount, parseDollars, PREVIEW_DEALS, readRules, rulesFromQuery, rulesPreview, rulesProblem, sameRules, WHOLE_DOLLARS_NOTE } from "../lib/rules.ts";
import { buildMissionRun, buildSingleRun, buildSteps, deriveView, type Decision, type Run } from "../lib/timeline.ts";
import { complete, declineLine, deliver, guardLine, pay, rebuildRun } from "../lib/server/agent.ts";
import { PayPalClient } from "../lib/server/paypal.ts";
import { toCents } from "../lib/money.ts";
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

test("rebuildRun with rules: your budget and limit, a scaled reserve, capped item limits", () => {
  const mission = getMission(MISSION);
  const run = rebuildRun(ref(42, { budgetUsd: 150, askAboveUsd: 60 }));
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
  // Single items have no reserve, keep none, and play the same deal.
  const single = buildSingleRun("webcam", 3, false, { budgetUsd: 200, askAboveUsd: 30 });
  assert.equal(single.lines[0].rules.reserveUsd, undefined);
  assert.equal(single.lines[0].rules.askAboveUsd, 30);
  assert.deepEqual(deals(single), deals(buildSingleRun("webcam", 3)));
});

/** A small deterministic random source for the sweep. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return (lo: number, hi: number) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return lo + (s % (hi - lo + 1));
  };
}
const dealTotal = (run: Run) => run.lines.reduce((sum, l) => sum + (l.deal.outcome.status === "deal" ? toCents(l.deal.outcome.amountToPay!) : 0), 0);

test("with your rules the engine never plans past the budget: 2,000 random setups", () => {
  const rnd = lcg(20261107);
  const ids = ["hackathon-10-days", "launch-week", "home-studio"];
  let skips = 0;
  for (let i = 0; i < 2000; i++) {
    const budgetUsd = rnd(100, 1000);
    const rules = { budgetUsd, askAboveUsd: Math.min(budgetUsd, rnd(25, 300)) };
    const r: RunRef = { kind: "mission", id: ids[rnd(0, 2)], seed: rnd(1, 999_999_999), nonce: "sweepnonce1", rules };
    const run = rebuildRun(r);
    assert.ok(dealTotal(run) <= budgetUsd * 100, `${r.id} deal ${r.seed} at $${budgetUsd}: deals total $${dealTotal(run) / 100}`);
    // AgentGuard never has to block for the budget: paying every deal still fits.
    skips += run.lines.filter((l) => l.deal.outcome.budgetSkip).length;
  }
  assert.ok(skips > 0, "some items are skipped for the budget");
  // Single items: the limit never goes above the budget.
  for (const id of ["usb-mic", "copywriter", "portable-monitor"]) {
    const run = buildSingleRun(id, 5, false, { budgetUsd: 100, askAboveUsd: 25 });
    assert.ok(run.lines[0].rules.itemCapUsd! <= 100);
    assert.ok(dealTotal(run) <= 10000);
  }
});

test("a low budget makes the agent skip an item, in plain words, before any money moves", () => {
  const r = buildMissionRun(MISSION, 42, { budgetUsd: 120, askAboveUsd: 40 });
  const skipped = r.lines.find((l) => l.deal.outcome.budgetSkip)!;
  assert.ok(skipped, "deal 42 at $120 skips an item");
  assert.equal(skipped.deal.outcome.status, "walk-away");
  const words = skipped.deal.beats.map((b) => b.text).join(" ");
  assert.match(words, /\$120 budget/);
  assert.match(words, /Budget guard: the agent skips the .+ to stay within your \$120 budget\./);
  const s = screen(r);
  assert.equal(s[r.lines.indexOf(skipped)], "no-deal");
  assert.ok(!s.includes("blocked"), "nothing needs blocking");
  const steps = buildSteps(r, { 0: "approved" }).steps;
  const view = deriveView(r, steps, steps.findIndex((x) => x.type === "line-end" && x.line === r.lines.indexOf(skipped)) + 1);
  assert.match(view.checkout[0].text, /Skipped to stay within your \$120 budget/);
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
      assert.ok(run.lines.every((l) => !l.deal.outcome.budgetSkip));
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

/** A fake PayPal with state: a reused request id returns the original order, as PayPal does. */
function fakePayPal() {
  const byRequest = new Map<string, string>();
  const orders = new Map<string, { id: string; status: string; cents: number; payments?: unknown }>();
  let capturedCents = 0;
  const view = (o: { id: string; status: string; payments?: unknown }) => ({
    id: o.id,
    status: o.status,
    purchase_units: o.payments ? [{ payments: o.payments }] : [{}],
    links: o.status === "COMPLETED" ? [] : [{ rel: "payer-action", href: `https://sandbox.example/approve/${o.id}` }],
  });
  const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
    if (u.pathname === "/v1/oauth2/token") return json({ access_token: "tok", expires_in: 3600 });
    const body = typeof init?.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : null;
    if (u.pathname === "/v2/checkout/orders") {
      const rid = new Headers(init?.headers).get("PayPal-Request-Id")!;
      let id = byRequest.get(rid);
      if (!id) {
        id = `ORDER${orders.size + 1}`;
        byRequest.set(rid, id);
        orders.set(id, { id, status: "PAYER_ACTION_REQUIRED", cents: Math.round(Number(body.purchase_units[0].amount.value) * 100) });
      }
      return json(view(orders.get(id)!), 201);
    }
    const one = u.pathname.match(/^\/v2\/checkout\/orders\/(\w+)$/);
    if (one) return json(view(orders.get(one[1])!));
    const act = u.pathname.match(/^\/v2\/checkout\/orders\/(\w+)\/(capture|authorize)$/);
    if (act) {
      const o = orders.get(act[1])!;
      if (o.status === "COMPLETED") return json({ name: "UNPROCESSABLE_ENTITY", message: "done", details: [{ issue: act[2] === "capture" ? "ORDER_ALREADY_CAPTURED" : "ORDER_ALREADY_AUTHORIZED" }] }, 422);
      if (o.status !== "APPROVED") return json({ name: "UNPROCESSABLE_ENTITY", message: "not approved", details: [{ issue: "ORDER_NOT_APPROVED" }] }, 422);
      o.status = "COMPLETED";
      capturedCents += o.cents;
      o.payments = act[2] === "capture" ? { captures: [{ id: `CAP-${o.id}`, status: "COMPLETED" }] } : { authorizations: [{ id: `AUTH-${o.id}`, status: "CREATED" }] };
      return json(view(o), 201);
    }
    const auth = u.pathname.match(/^\/v2\/payments\/authorizations\/([\w-]+)\/(capture|void)$/);
    if (auth) return auth[2] === "capture" ? json({ id: `CAP2-${auth[1]}`, status: "COMPLETED" }, 201) : new Response(null, { status: 204 });
    return json({ name: "NOT_FOUND", message: u.pathname }, 404);
  };
  const client = new PayPalClient({ base: "https://paypal.test", clientId: "id", secret: "secret", fetch: fetchFn as typeof fetch, timeoutMs: 200, backoffMs: 1 });
  return { client, approve: (id: string) => (orders.get(id)!.status = "APPROVED"), paid: () => capturedCents };
}

/** Pays a line with PayPal, approving in the PayPal window whenever asked. Returns the new ledger. */
async function payLine(r: RunRef, line: number, ledger: Ledger, pp: ReturnType<typeof fakePayPal>): Promise<Ledger> {
  const res = await pay(r, line, ledger, true, { paypal: pp.client, vaultId: null, returnUrl: "https://app/paypal/return" });
  if (res.decision !== "needs_paypal_approval") return res.ledger;
  pp.approve(res.orderId);
  const done = await complete(r, line, res.ledger, pp.client);
  return done.ledger;
}

test("declines plus resent older ledgers can't take spending past the budget", async () => {
  // Budget $120, ask above $40: decline line 0, pay the rest, then replay line 0 with no ledger.
  {
    const pp = fakePayPal();
    const r = ref(42, { budgetUsd: 120, askAboveUsd: 40 }, "replayone01");
    const run = rebuildRun(r);
    let l = declineLine(r, 0, emptyLedger(r));
    for (let i = 1; i < run.lines.length; i++) if (run.lines[i].deal.outcome.status === "deal") l = await payLine(r, i, l, pp);
    await payLine(r, 0, emptyLedger(r), pp);
    assert.ok(pp.paid() <= 12000, `paid $${pp.paid() / 100} of $120`);
  }
  // Budget $150, ask above $50: pay 0, decline 1, pay 2, then replay line 1 with the older ledger.
  {
    const pp = fakePayPal();
    const r = ref(42, { budgetUsd: 150, askAboveUsd: 50 }, "replaytwo01");
    const run = rebuildRun(r);
    const L1 = await payLine(r, 0, emptyLedger(r), pp);
    let l = run.lines[1].deal.outcome.status === "deal" ? declineLine(r, 1, L1) : L1;
    if (run.lines[2].deal.outcome.status === "deal") l = await payLine(r, 2, l, pp);
    if (run.lines[1].deal.outcome.status === "deal") await payLine(r, 1, L1, pp);
    assert.ok(pp.paid() <= 15000, `paid $${pp.paid() / 100} of $150`);
  }
});

test("a decline racing a capture still stays within the budget", async () => {
  for (const [budgetUsd, askAboveUsd] of [[120, 40], [150, 50], [100, 25]]) {
    const pp = fakePayPal();
    const r = ref(42, { budgetUsd, askAboveUsd }, `racenonce${budgetUsd}`);
    const run = rebuildRun(r);
    const ctx = { paypal: pp.client, vaultId: null, returnUrl: "https://app/paypal/return" };
    // Line 0 waits in PayPal; the buyer approves while the deal room declines it.
    const waiting = await pay(r, 0, emptyLedger(r), true, ctx);
    assert.equal(waiting.decision, "needs_paypal_approval");
    pp.approve((waiting as { orderId: string }).orderId);
    const [captured, declined] = [await complete(r, 0, waiting.ledger, pp.client), declineLine(r, 0, waiting.ledger)];
    assert.notEqual((captured as { state?: string }).state, undefined);
    // Everything else is paid on the ledger that says line 0 was declined.
    let l = declined;
    for (let i = 1; i < run.lines.length; i++) if (run.lines[i].deal.outcome.status === "deal") l = await payLine(r, i, l, pp);
    // And every line replayed once more with no ledger at all.
    for (let i = 0; i < run.lines.length; i++) if (run.lines[i].deal.outcome.status === "deal") await payLine(r, i, emptyLedger(r), pp);
    assert.ok(pp.paid() <= budgetUsd * 100, `paid $${pp.paid() / 100} of $${budgetUsd}`);
    assert.ok(pp.paid() <= dealTotal(run), "each line paid at most once");
  }
});

test("the rules preview comes from the engine: the usual result over deals 1–25", () => {
  const usual = (rules: { budgetUsd: number; askAboveUsd: number }) => {
    const n = Array.from({ length: PREVIEW_DEALS }, (_, k) => paidCount(buildMissionRun(MISSION, k + 1, rules))).sort((a, b) => a - b);
    return n[Math.floor(n.length / 2)];
  };
  for (const rules of [{ budgetUsd: 300, askAboveUsd: 100 }, { budgetUsd: 120, askAboveUsd: 40 }, { budgetUsd: 100, askAboveUsd: 25 }]) {
    const text = rulesPreview("mission", MISSION, rules);
    const n = usual(rules);
    const buys = n === 3 ? "all 3 items" : `${n} of 3 items`;
    assert.ok(text.startsWith(`With $${rules.budgetUsd}, your agent usually buys ${buys}`), text);
    assert.ok(text.endsWith(` · anything over $${rules.askAboveUsd} asks you first`), text);
  }
  assert.match(rulesPreview("mission", MISSION, { budgetUsd: 120, askAboveUsd: 40 }), /usually buys 2 of 3 items and skips the rest to stay in budget · /, "matches what deal 42 actually does");
  assert.match(rulesPreview("mission", MISSION, { budgetUsd: 300, askAboveUsd: 100 }), /usually buys all 3 items · /);
  assert.match(rulesPreview("mission", "launch-week", { budgetUsd: 1000, askAboveUsd: 300 }), /^With \$1,000, .* anything over \$300 asks you first$/, "thousands commas");
  assert.match(rulesPreview("single", "usb-mic", { budgetUsd: 300, askAboveUsd: 100 }), /usually gets it/);
  assert.match(rulesPreview("rogue", "usb-mic", { budgetUsd: 300, askAboveUsd: 100 }), /held to \$70/);
});

test("typed amounts: decimals round to whole dollars, letters keep the rules in force", () => {
  const fallback = { budgetUsd: 300, askAboveUsd: 100 };
  assert.deepEqual(clampDraft("150.5", "60", fallback), { rules: { budgetUsd: 151, askAboveUsd: 60 }, note: "Rounded to whole dollars" });
  assert.deepEqual(clampDraft("150.4", "60", fallback), { rules: { budgetUsd: 150, askAboveUsd: 60 }, note: "Rounded to whole dollars" });
  assert.deepEqual(clampDraft("$1,000", "60", fallback), { rules: { budgetUsd: 1000, askAboveUsd: 60 }, note: null });
  assert.deepEqual(clampDraft("15o", "60", fallback), { rules: { budgetUsd: 300, askAboveUsd: 60 }, note: WHOLE_DOLLARS_NOTE });
  assert.deepEqual(clampDraft("150", "abc", fallback), { rules: { budgetUsd: 150, askAboveUsd: 100 }, note: WHOLE_DOLLARS_NOTE });
  assert.deepEqual(clampDraft("", "", fallback), { rules: fallback, note: null });
  assert.equal(parseDollars("1.2.3"), null);
  assert.equal(parseDollars("-5"), null);
});

test("money reads with thousands commas", () => {
  assert.equal(fmt(1000), "$1,000");
  assert.equal(fmt(19.9), "$19.90");
  assert.match(rulesProblem({ budgetUsd: 5000, askAboveUsd: 60 })!, /\$1,000/);
  assert.match(buildMissionRun(MISSION, 42, { budgetUsd: 1000, askAboveUsd: 300 }).goal, /Budget \$1,000\./);
});
