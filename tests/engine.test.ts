import { test } from "node:test";
import assert from "node:assert/strict";
import { catalog, checkPayment, getItem, missions, planBuyer, runDeal, runMission } from "../src/engine/index.ts";

const SEEDS = Array.from({ length: 60 }, (_, i) => i + 1);

test("buyer plan rises in shrinking steps and ends at the walk-away price", () => {
  for (const item of catalog.items) {
    const plan = planBuyer(item);
    assert.equal(plan.offers[0], plan.anchor, item.id);
    assert.equal(plan.offers.at(-1), plan.walkAway, item.id);
    for (let i = 1; i < plan.offers.length; i++) assert.ok(plan.offers[i] > plan.offers[i - 1], `${item.id} rises`);
    for (let i = 2; i < plan.offers.length; i++) {
      assert.ok(plan.offers[i] - plan.offers[i - 1] <= plan.offers[i - 1] - plan.offers[i - 2], `${item.id} steps shrink`);
    }
  }
});

test("walk-away price never exceeds the item cap", () => {
  const plan = planBuyer(getItem("usb-mic"), 45);
  assert.ok(plan.walkAway <= 45);
  assert.ok(plan.anchor <= plan.walkAway);
});

test("the same seed replays the same deal", () => {
  const a = runDeal("video-editor", { seed: 1234 });
  const b = runDeal("video-editor", { seed: 1234 });
  assert.deepEqual(a.beats, b.beats);
  assert.deepEqual(a.outcome, b.outcome);
});

test("every item, many seeds: deals stay within the walk-away price and above seller floors", () => {
  let deals = 0;
  let total = 0;
  for (const item of catalog.items) {
    for (const seed of SEEDS) {
      const d = runDeal(item.id, { seed });
      total++;
      for (const s of d.sellers) assert.ok(s.finalAsk >= s.floor, `${item.id}#${seed} ${s.name} asked below floor`);
      if (d.outcome.status !== "deal") continue;
      deals++;
      const o = d.outcome;
      const seller = d.sellers.find((s) => s.id === o.sellerId)!;
      assert.ok(o.price! >= seller.floor, `${item.id}#${seed} paid below the seller floor`);
      assert.ok(o.amountToPay! <= d.plan.cap, `${item.id}#${seed} paid $${o.amountToPay} over the cap $${d.plan.cap}`);
      if (o.amountToPay! > d.plan.walkAway) assert.ok(d.beats.some((b) => b.kind === "agent" && b.move === "explain"), `${item.id}#${seed} stretched without saying why`);
      // Later fees (renewals) count when ranking sellers, not against today's walk-away price.
      assert.ok(o.effectiveCost === o.amountToPay! + o.futureFee, `${item.id}#${seed} effective cost`);
    }
  }
  // The agent should close most deals, but not all: walking away is part of the game.
  const rate = deals / total;
  assert.ok(rate > 0.6 && rate < 1, `deal rate ${rate.toFixed(2)}`);
});

test("rogue mode: the agent falls for an upsell and AgentGuard blocks it", () => {
  for (const seed of SEEDS) {
    const d = runDeal("usb-mic", { seed, rogue: true, itemCapUsd: 70 });
    assert.equal(d.outcome.rogue, true, `seed ${seed}`);
    const g = checkPayment({ amount: d.outcome.amountToPay!, spentSoFar: 0, sellerId: d.outcome.sellerId!, sellerName: d.outcome.sellerName!, rules: { budgetUsd: 300, askAboveUsd: 100, itemCapUsd: 70 } });
    assert.equal(g.decision, "block", `seed ${seed}`);
  }
});

test("AgentGuard decisions", () => {
  const rules = { budgetUsd: 300, askAboveUsd: 100, itemCapUsd: 130 };
  const pay = (amount: number, spentSoFar = 0, extra: object = {}) =>
    checkPayment({ amount, spentSoFar, sellerId: "s1", sellerName: "A", rules, ...extra }).decision;
  assert.equal(pay(47), "approve");
  assert.equal(pay(115, 47), "ask_user");
  assert.equal(pay(150), "block");
  assert.equal(pay(120, 200), "block");
  assert.equal(pay(-5), "block");
  assert.equal(pay(10.005), "block");
  assert.equal(pay(20, 0, { currency: "EUR" }), "block");
  assert.equal(pay(20, 0, { alreadyPaid: true }), "block");
  assert.equal(pay(20, 0, { rules: { ...rules, blockedSellerIds: ["s1"] } }), "block");
  assert.equal(pay(20, 0, { group: "fun", rules: { ...rules, allowedGroups: ["gear"] } }), "block");
  assert.equal(pay(50, 200, { rules: { ...rules, reserveUsd: 60 } }), "ask_user");
  assert.equal(pay(19.99), "approve", "valid cents");
  assert.equal(pay(0.29), "approve");
  assert.equal(pay(20, 0, { surpriseFee: true }), "ask_user");
  assert.equal(pay(20, 0, { laterFee: 25 }), "ask_user");
  assert.equal(pay(20, 0, { agreedAmount: 19 }), "block", "amount must match the agreed price");
});

test("missions never spend more than the budget", () => {
  for (const m of missions) {
    for (const seed of SEEDS.slice(0, 20)) {
      const r = runMission(m.id, { seed, includeNice: true });
      assert.ok(r.spentUsd + r.pendingUsd <= r.budgetUsd, `${m.id}#${seed}`);
      for (const line of r.lines) if (line.status === "paid" || line.status === "voided") assert.equal(line.guard?.decision, "approve");
    }
  }
});

test("sellers remember a lowball offer", () => {
  let memory = {};
  for (const seed of SEEDS.slice(0, 10)) memory = runDeal("portable-monitor", { seed, memory }).memory;
  const insults = Object.values(memory as Record<string, { lowballs: number }>).reduce((n, m) => n + m.lowballs, 0);
  assert.ok(insults > 0);
});
