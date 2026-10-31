// Commitment and cost-model checks for negotiations. Each test guards a fixed bug.
import { test } from "node:test";
import assert from "node:assert/strict";
import { catalog, getItem, runDeal } from "../src/engine/index.ts";
import type { DealResult } from "../src/engine/index.ts";

const SEEDS = Array.from({ length: 200 }, (_, i) => i + 1);
const each = (fn: (d: DealResult, tag: string) => void) => {
  for (const it of catalog.items) for (const seed of SEEDS) fn(runDeal(it.id, { seed }), `${it.id}#${seed}`);
};
/** Known checkout fee per seller, from detect beats seen so far. */
function nowFeeTracker(d: DealResult) {
  const item = getItem(d.itemId);
  const fee = new Map<string, number>();
  return {
    see(b: DealResult["beats"][number]) {
      const m = b.kind === "detect" ? b.text.match(/hidden fee of \$(\d+): (.+)$/) : null;
      if (m && b.kind === "detect") fee.set(b.sellerId, item.hiddenFees.find((f) => f.label === m[2])?.payNow ? Number(m[1]) : 0);
    },
    get: (id: string) => fee.get(id) ?? 0,
  };
}

test("'hold' wording is only used when the all-in offer is unchanged", () => {
  each((d, tag) => {
    const fees = nowFeeTracker(d);
    const last = new Map<string, number>();
    for (const b of d.beats) {
      fees.see(b);
      if (b.kind !== "agent" || b.move !== "offer" || b.price === undefined) continue;
      const id = b.to[0];
      const allIn = b.price + fees.get(id);
      if (/still|staying/i.test(b.text) && last.has(id)) assert.equal(allIn, last.get(id), `${tag} R${b.round}: ${b.text}`);
      last.set(id, allIn);
    }
  });
});

test("a quote request never cites a price worse than the recipient's own quote", () => {
  each((d, tag) => {
    const fees = nowFeeTracker(d);
    const ask = new Map(d.sellers.map((s) => [s.id, s.openAsk]));
    for (const b of d.beats) {
      fees.see(b);
      if (b.kind === "seller" && b.price !== undefined && ["counter", "final", "accept", "absorb-fee"].includes(b.move)) ask.set(b.sellerId, b.price);
      if (b.kind === "agent" && b.move === "quote-request" && b.refPrice !== undefined) {
        const own = ask.get(b.to[0])! + fees.get(b.to[0]);
        assert.ok(b.refPrice <= own, `${tag} R${b.round}: recipient at $${own}: ${b.text}`);
      }
    }
  });
});

test("delivery-record explanations are never given for instant digital items", () => {
  each((d, tag) => {
    if (getItem(d.itemId).delivery !== "instant") return;
    for (const b of d.beats) if (b.kind === "agent" && b.move === "explain") assert.doesNotMatch(b.text, /deliver/, `${tag}: ${b.text}`);
  });
});

test("the agent never asks a seller to absorb a fee it already included in an accepted all-in offer", () => {
  each((d, tag) => {
    const known = new Set<string>();
    const acceptedKnowing = new Set<string>();
    for (const b of d.beats) {
      if (b.kind === "detect" && /hidden fee/.test(b.text)) known.add(b.sellerId);
      if (b.kind === "seller" && b.move === "accept" && known.has(b.sellerId)) acceptedKnowing.add(b.sellerId);
      if (b.kind === "agent" && b.move === "absorb-fee") assert.ok(!acceptedKnowing.has(b.to[0]), `${tag}: ${b.text}`);
    }
  });
});

test("the stretch and later-fee paths are reachable in normal play", () => {
  let stretched = 0;
  let later = 0;
  each((d) => {
    if (d.outcome.status !== "deal") return;
    if ((d.outcome.amountToPay ?? 0) > d.plan.walkAway) stretched++;
    if (d.outcome.futureFee > 0) later++;
  });
  assert.ok(stretched > 0 && later > 0, `stretched ${stretched}, later-fee deals ${later}`);
});
