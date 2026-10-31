// Negotiation quality checks from QA. Each one guards against a bug that was found and fixed.
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
  for (const b of d.beats) {
    if (b.kind === "seller" && (b.move === "reveal-fee" || b.move === "surprise-fee") && b.price !== undefined) fees.set(b.sellerId, b.price);
    // Fees can also come out through a "fine print" event.
    const m = b.kind === "detect" ? b.text.match(/hidden fee of \$(\d+)/) : null;
    if (m && b.kind === "detect") fees.set(b.sellerId, Number(m[1]));
  }
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

test("seller counter-offers never go below the agent's standing offer", () => {
  allDeals((d, tag) => {
    const offerTo = new Map<string, number>();
    for (const b of d.beats) {
      if (b.kind === "agent" && b.price !== undefined && (b.move === "anchor" || b.move === "offer" || b.move === "leverage")) for (const id of b.to) offerTo.set(id, b.price);
      // An event (flash sale, price match) or a fresh quote request resets the comparison.
      if (b.kind === "event") offerTo.delete(b.sellerId);
      if (b.kind === "agent" && b.move === "quote-request") for (const id of b.to) offerTo.delete(id);
      if (b.kind === "seller" && (b.move === "counter" || b.move === "final") && b.price !== undefined) {
        const o = offerTo.get(b.sellerId);
        assert.ok(o === undefined || b.price >= o, `${tag}: agent offered $${o}, seller countered $${b.price}`);
      }
    }
  });
});

test("the agent never raises its offer to a seller who already accepted a lower price", () => {
  allDeals((d, tag) => {
    const accepted = new Map<string, number>();
    for (const b of d.beats) {
      if (b.kind === "agent" && b.price !== undefined && (b.move === "offer" || b.move === "leverage"))
        for (const id of b.to) assert.ok(!accepted.has(id) || b.price <= accepted.get(id)!, `${tag}: offers $${b.price} after a yes at $${accepted.get(id)}`);
      if (b.kind === "seller" && b.move === "accept" && b.price !== undefined) accepted.set(b.sellerId, b.price);
    }
  });
});

test("a walk-away never follows a seller saying 'You have a deal' at or under the walk-away price", () => {
  allDeals((d, tag) => {
    if (d.outcome.status !== "walk-away") return;
    // A yes is fine only if the agent later turned that seller down with a reason.
    d.beats.forEach((b, i) => {
      if (b.kind !== "seller" || b.move !== "accept" || (b.price ?? Infinity) > d.plan.walkAway) return;
      const answered = d.beats.slice(i + 1).some((x) => x.kind === "agent" && x.to.includes(b.sellerId) && ["priced-out", "reject-fee", "decline"].includes(x.move));
      assert.ok(answered, `${tag}: ${b.text}`);
    });
  });
});

test("the agent never pays more than another active seller's known all-in price", () => {
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

test("every catalog item can be bought on at least a third of seeds", () => {
  for (const item of catalog.items) {
    const deals = SEEDS.filter((seed) => runDeal(item.id, { seed }).outcome.status === "deal").length;
    assert.ok(deals / SEEDS.length >= 1 / 3, `${item.id}: ${deals}/${SEEDS.length} deals`);
  }
});

test("lever and anchor texts read naturally", () => {
  allDeals((d, tag) => {
    for (const b of d.beats) {
      assert.doesNotMatch(b.text, /\b[Aa] (?!one|uni|use|usu|eu|U[A-Z])[aeiouAEIOU]/, `${tag}: ${b.text}`);
      assert.doesNotMatch(b.text, /included included/i, `${tag}: ${b.text}`);
    }
  });
});

test("missions: AgentGuard's running total ignores money that was refunded", () => {
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

test("a seller who accepts a firm offer is never declined (a yes is a commitment)", () => {
  allDeals((d, tag) => {
    d.beats.forEach((b, i) => {
      if (b.kind !== "seller" || b.move !== "accept") return;
      const declined = d.beats.slice(i + 1).some((x) => x.kind === "agent" && x.move === "decline" && x.to.includes(b.sellerId));
      assert.ok(!declined, `${tag}: ${b.text} was later declined`);
    });
  });
});

test("only one seller per round gets a firm offer; the rest get quote requests", () => {
  allDeals((d, tag) => {
    const firm = new Map<number, number>();
    for (const b of d.beats) if (b.kind === "agent" && b.move === "offer") firm.set(b.round, (firm.get(b.round) ?? 0) + b.to.length);
    for (const [round, n] of firm) assert.ok(n <= 1, `${tag} round ${round}: ${n} firm offers`);
  });
});

test("one cost model: never pay over the stretch, and say why when paying over walk-away", () => {
  allDeals((d, tag) => {
    const o = d.outcome;
    if (o.status !== "deal" || o.rogue) return;
    assert.ok(o.effectiveCost! <= d.plan.stretch, `${tag}: true cost $${o.effectiveCost} over stretch $${d.plan.stretch}`);
    if (o.amountToPay! > d.plan.walkAway) assert.ok(d.beats.some((b) => b.kind === "agent" && b.move === "explain"), `${tag}: over walk-away without a reason`);
    const explains = d.beats.filter((b) => b.kind === "agent" && b.move === "explain").length;
    assert.ok(explains <= 1, `${tag}: ${explains} explanations`);
  });
});
