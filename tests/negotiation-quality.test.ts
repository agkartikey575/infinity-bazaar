// Negotiation quality checks found in QA. Tests marked `todo` describe known
// bugs: they run and report, but do not fail `npm test` until the engine is fixed.
// Remove the `todo` option once a fix lands.
import { test } from "node:test";
import assert from "node:assert/strict";
import { catalog, getMission, runDeal, runMission } from "../src/engine/index.ts";
import type { DealResult } from "../src/engine/index.ts";

const SEEDS = Array.from({ length: 80 }, (_, i) => i + 1);

function allDeals(fn: (d: DealResult, tag: string) => void) {
  for (const item of catalog.items) for (const seed of SEEDS) fn(runDeal(item.id, { seed }), `${item.id}#${seed}`);
}

/** Known fee per seller, as the agent learned it during the deal. */
function knownFees(d: DealResult) {
  const fees = new Map<string, number>();
  for (const b of d.beats) if (b.kind === "seller" && (b.move === "reveal-fee" || b.move === "surprise-fee") && b.price !== undefined) fees.set(b.sellerId, b.price);
  return fees;
}

test("no '$undefined', NaN or empty texts in any beat", () => {
  allDeals((d, tag) => {
    for (const b of d.beats) {
      assert.ok(b.text.trim().length > 0, `${tag}: empty text`);
      assert.doesNotMatch(b.text, /\bundefined\b|\bNaN\b|\$Infinity|\bnull\b|\{\w+\}/, `${tag}: ${b.text}`);
    }
  });
});

test("a seller that exits never speaks again", () => {
  allDeals((d, tag) => {
    const out = new Set<string>();
    for (const b of d.beats) {
      if (b.kind === "seller") {
        assert.ok(!out.has(b.sellerId), `${tag}: ${b.text}`);
        if (b.move === "exit") out.add(b.sellerId);
      }
    }
  });
});

test("seller counter-offers never go below the agent's standing offer", { todo: "reply() compares the offer with the OLD ask, then concedes below the offer" }, () => {
  allDeals((d, tag) => {
    const offerTo = new Map<string, number>();
    for (const b of d.beats) {
      if (b.kind === "agent" && b.price !== undefined && (b.move === "anchor" || b.move === "offer" || b.move === "leverage")) for (const id of b.to) offerTo.set(id, b.price);
      // An event (flash sale, price match) may drop a seller's own price; that resets the comparison.
      if (b.kind === "event") offerTo.delete(b.sellerId);
      if (b.kind === "seller" && (b.move === "counter" || b.move === "final") && b.price !== undefined) {
        const o = offerTo.get(b.sellerId);
        assert.ok(o === undefined || b.price >= o, `${tag}: agent offered $${o}, seller countered $${b.price}`);
      }
    }
  });
});

test("the agent never raises its offer to a seller who already accepted a lower price", { todo: "accepted sellers that fail tryClose are silently ignored" }, () => {
  allDeals((d, tag) => {
    const accepted = new Map<string, number>();
    for (const b of d.beats) {
      if (b.kind === "agent" && b.price !== undefined && (b.move === "offer" || b.move === "leverage"))
        for (const id of b.to) assert.ok(!accepted.has(id) || b.price <= accepted.get(id)!, `${tag}: offers $${b.price} after a yes at $${accepted.get(id)}`);
      if (b.kind === "seller" && b.move === "accept" && b.price !== undefined) accepted.set(b.sellerId, b.price);
    }
  });
});

test("a walk-away never follows a seller saying 'You have a deal' at or under the walk-away price", { todo: "walkAway text 'Nobody came under $X' contradicts acceptances rejected for fees" }, () => {
  allDeals((d, tag) => {
    if (d.outcome.status !== "walk-away") return;
    const yes = d.beats.filter((b) => b.kind === "seller" && b.move === "accept" && (b.price ?? Infinity) <= d.plan.walkAway);
    assert.equal(yes.length, 0, tag);
  });
});

test("the agent never pays more than another active seller's known all-in price", { todo: "a surprise fee at checkout is not re-compared with the other sellers" }, () => {
  allDeals((d, tag) => {
    const o = d.outcome;
    if (o.status !== "deal" || o.rogue) return;
    const fees = knownFees(d);
    const paid = (o.amountToPay ?? 0) + o.futureFee;
    // Paying more is fine only when the agent said why (delivery reliability).
    if (d.beats.some((b) => b.kind === "agent" && b.move === "explain")) return;
    for (const s of d.sellers) {
      if (s.id === o.sellerId || !s.active) continue;
      const other = s.finalAsk + (fees.get(s.id) ?? 0);
      assert.ok(other >= paid, `${tag}: paid ${o.sellerName} $${paid}, ${s.name} was at $${other}`);
    }
  });
});

test("every catalog item can be bought on at least a third of seeds", { todo: "ai-credits closes ~4% of the time: the $15 'credits expire' fee pushes every floor over the walk-away" }, () => {
  for (const item of catalog.items) {
    const deals = SEEDS.filter((seed) => runDeal(item.id, { seed }).outcome.status === "deal").length;
    assert.ok(deals / SEEDS.length >= 1 / 3, `${item.id}: ${deals}/${SEEDS.length} deals`);
  }
});

test("lever and anchor texts read naturally", { todo: "'a ai api credits', 'a energy drinks', 'sms alerts included included'" }, () => {
  allDeals((d, tag) => {
    for (const b of d.beats) {
      assert.doesNotMatch(b.text, /\ba [aeiou]/i, `${tag}: ${b.text}`);
      assert.doesNotMatch(b.text, /included included/i, `${tag}: ${b.text}`);
    }
  });
});

test("missions: AgentGuard's running total ignores money that was refunded", { todo: "runMission adds refunded (after-payment) amounts to spentSoFar" }, () => {
  for (const seed of Array.from({ length: 200 }, (_, i) => i + 1)) {
    const r = runMission("hackathon-10-days", { seed, includeNice: true });
    let spent = 0;
    for (const l of r.lines) {
      if (!l.guard) continue;
      const total = l.guard.checks.find((c) => c.label.startsWith("total"));
      const amount = l.deal.outcome.amountToPay ?? 0;
      assert.equal(total?.label.match(/total \$([\d.]+)/)?.[1], (spent + amount).toFixed(2), `seed ${seed} ${l.itemId}`);
      // Approval-pending money is reserved; refunded money is not.
      if (l.status === "paid" || l.status === "needs-approval") spent += amount;
    }
    assert.ok(getMission("hackathon-10-days"));
  }
});
