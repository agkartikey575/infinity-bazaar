// Realism checks for negotiation transcripts. Each test guards a fixed bug.
import { test } from "node:test";
import assert from "node:assert/strict";
import { catalog, getItem, runDeal } from "../src/engine/index.ts";
import type { DealResult } from "../src/engine/index.ts";
import { buildSingleRun } from "../lib/timeline.ts";

const SEEDS = Array.from({ length: 120 }, (_, i) => i + 1);

function allDeals(fn: (d: DealResult, tag: string) => void, items = catalog.items.map((i) => i.id)) {
  for (const id of items) for (const seed of SEEDS) fn(runDeal(id, { seed }), `${id}#${seed}`);
}

/** Fees the agent learned during the deal, with whether they are charged now. */
function knownFees(d: DealResult) {
  const item = getItem(d.itemId);
  const fees = new Map<string, { usd: number; now: boolean }>();
  const note = (id: string, usd: number) => fees.set(id, { usd, now: Boolean(item.hiddenFees.find((f) => f.valueUsd === usd)?.payNow) });
  for (const b of d.beats) {
    if (b.kind === "seller" && (b.move === "reveal-fee" || b.move === "surprise-fee") && b.price !== undefined) note(b.sellerId, b.price);
    const m = b.kind === "detect" ? b.text.match(/hidden fee of \$(\d+)/) : null;
    if (m && b.kind === "detect") note(b.sellerId, Number(m[1]));
  }
  return fees;
}

test("the agent never drops a seller whose true cost beats the one it pays", () => {
  allDeals((d, tag) => {
    const o = d.outcome;
    if (o.status !== "deal" || o.rogue) return;
    const fees = knownFees(d);
    const paidTrue = (o.amountToPay ?? 0) + o.futureFee;
    for (const b of d.beats) {
      if (b.kind !== "agent" || b.move !== "priced-out") continue;
      const s = d.sellers.find((x) => x.id === b.to[0])!;
      const fee = fees.get(s.id);
      const allIn = s.finalAsk + (fee?.now ? fee.usd : 0);
      const trueCost = s.finalAsk + (fee?.usd ?? 0);
      if (allIn <= d.plan.cap) assert.ok(trueCost >= paidTrue, `${tag}: dropped ${s.name} at $${trueCost}, paid ${o.sellerName} $${paidTrue}`);
    }
  });
});

test("a seller who absorbs a fee never raises the agreed total without saying the cut is partial", () => {
  allDeals((d, tag) => {
    const last = new Map<string, number>();
    for (const b of d.beats) {
      if (b.kind !== "seller" || b.price === undefined) continue;
      if (b.move === "absorb-fee") {
        const fee = knownFees({ ...d, beats: d.beats.slice(0, d.beats.indexOf(b)) }).get(b.sellerId)?.usd ?? 0;
        // A full "we'll cover it" never raises the total; a partial cut must say it is partial.
        if (b.price + fee > last.get(b.sellerId)!) assert.match(b.text, /That's all I can do/, `${tag}: ${b.text}`);
      }
      if (["counter", "final", "accept", "absorb-fee"].includes(b.move)) last.set(b.sellerId, b.price);
    }
  });
});

test("'move up' wording is never used for the same or a lower offer", () => {
  allDeals((d, tag) => {
    const fees = knownFees(d);
    const last = new Map<string, number>();
    for (const b of d.beats) {
      if (b.kind !== "agent" || (b.move !== "offer" && b.move !== "leverage") || b.price === undefined) continue;
      const id = b.to[0];
      const allIn = b.price + (fees.get(id)?.now ? fees.get(id)!.usd : 0);
      const prev = last.get(id);
      if (prev !== undefined && /move to|real step|come up/i.test(b.text)) assert.ok(allIn > prev, `${tag}: ${b.text} (was $${prev})`);
      last.set(id, allIn);
    }
  });
});

test("'over my limit with your fees' is only said to a seller with a known fee", () => {
  allDeals((d, tag) => {
    const fees = knownFees(d);
    for (const b of d.beats) {
      if (b.kind === "agent" && b.move === "priced-out" && /fee/i.test(b.text)) assert.ok(fees.has(b.to[0]), `${tag}: ${b.text}`);
    }
  });
});

test("leverage commentary names only the sellers that were leveraged, with correct grammar", () => {
  allDeals((d, tag) => {
    for (const b of d.beats) {
      if (b.kind !== "commentary") continue;
      assert.doesNotMatch(b.text, /\band [A-Z][\w' ]* hears\b/, `${tag}: ${b.text}`);
      if (!/rival quote|against the leader|best offer on the table against/.test(b.text)) continue;
      const leveraged = new Set(d.beats.filter((x) => x.kind === "agent" && (x.move === "leverage" || x.move === "quote-request") && x.round === b.round).flatMap((x) => (x.kind === "agent" ? x.to : [])));
      for (const s of d.sellers) if (b.text.includes(s.name)) assert.ok(leveraged.has(s.id), `${tag} R${b.round}: ${b.text}`);
    }
  });
});

test("'came in lower' is only said when the winner really is cheaper", () => {
  allDeals((d, tag) => {
    const o = d.outcome;
    if (o.status !== "deal") return;
    const fees = knownFees(d);
    for (const b of d.beats) {
      if (b.kind !== "agent" || b.move !== "decline" || !/lower/.test(b.text)) continue;
      const s = d.sellers.find((x) => x.id === b.to[0])!;
      const f = fees.get(s.id);
      assert.ok((o.amountToPay ?? 0) + o.futureFee < s.finalAsk + (f?.usd ?? 0), `${tag}: told ${s.name} ($${s.finalAsk}) another came in lower; paid $${o.amountToPay}`);
    }
  });
});

test("a seller never claims 'no fees' after its fee was revealed", () => {
  allDeals((d, tag) => {
    const fees = new Set<string>();
    for (const b of d.beats) {
      if (b.kind === "detect" && /hidden fee/.test(b.text)) fees.add(b.sellerId);
      if (b.kind === "seller" && b.move === "no-fee") assert.ok(!fees.has(b.sellerId), `${tag}: ${b.text}`);
    }
  });
});

test("text: sentences start with a capital letter and item lines fit the item", () => {
  allDeals((d, tag) => {
    for (const b of d.beats) {
      assert.doesNotMatch(b.text, /(^|[.!?] )[a-z]/, `${tag}: ${b.text}`);
      if (d.itemId !== "video-editor") assert.doesNotMatch(b.text, /captions and colou?r grading/i, `${tag}: ${b.text}`);
    }
  });
});

test("a failed delivery says the hold is voided, matching the PayPal call", () => {
  allDeals((d, tag) => {
    if (d.outcome.afterPayment) assert.doesNotMatch(d.outcome.afterPayment.text, /refund/i, tag);
  });
});

test("rogue demo goal keeps acronyms capitalised", () => {
  assert.doesNotMatch(buildSingleRun("usb-mic", 1, true).goal, /\busb\b/);
});
