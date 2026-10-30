// Runs one negotiation: the buyer agent against three sellers in parallel.
import { planBuyer } from "./buyer.ts";
import { events as allEvents, getItem } from "./data.ts";
import { createRng, type Rng } from "./rng.ts";
import { effectiveCost, reply, riskAdjusted, spawnSellers, trueCost } from "./sellers.ts";
import { commentary, say } from "./text.ts";
import type { Beat, CatalogItem, DealOutcome, DealResult, GameEvent, Seller, SellerMemory } from "./types.ts";

export interface DealOptions {
  seed?: number;
  itemCapUsd?: number;
  memory?: SellerMemory;
  maxRounds?: number;
  /** Turn random events on (default) or off. */
  events?: boolean;
  /** Force these event ids instead of drawing at random. */
  forceEvents?: string[];
  /** Rogue demo: the agent is told to "get the best" and falls for an upsell. */
  rogue?: boolean;
}

interface Scheduled {
  round: number;
  event: GameEvent;
}

/** Chance that a seller with a hidden fee admits it when asked. */
const HONEST_ABOUT_FEES = 0.6;

export function runDeal(itemId: string, opts: DealOptions = {}): DealResult {
  const item = getItem(itemId);
  const seed = opts.seed ?? Math.floor(Math.random() * 2 ** 31);
  const rng = createRng(seed);
  const maxRounds = opts.maxRounds ?? 8;
  const memory: SellerMemory = structuredClone(opts.memory ?? {});
  const rogue = opts.rogue ?? false;

  const plan = planBuyer(item, opts.itemCapUsd);
  const sellers = spawnSellers(item, rng, memory, rogue);
  const openAsks = new Map(sellers.map((s) => [s.id, s.ask]));
  const beats: Beat[] = [];
  const active = () => sellers.filter((s) => s.active);
  const ranked = () => [...active()].sort((a, b) => riskAdjusted(a, item) - riskAdjusted(b, item));
  // The rogue demo is a set scene, so random events stay off there.
  const { scheduled, afterPayment } = scheduleEvents(item, sellers, rng, rogue ? { ...opts, events: false } : opts);

  let outcome: DealOutcome | null = null;

  const finish = (s: Seller, price: number, round: number, isRogue = false) => {
    const fee = s.fee && s.feeRevealed && s.fee.payNow ? s.fee.valueUsd : 0;
    const futureFee = s.fee && s.feeRevealed && !s.fee.payNow ? s.fee.valueUsd : 0;
    const saved = Math.round(((item.price.typical - trueCost(s, price)) / item.price.typical) * 100);
    if (!isRogue) {
      beats.push({ kind: "agent", round, to: [s.id], move: "accept", price, text: say.accept(rng, price) });
      beats.push({ kind: "commentary", round, text: commentary.deal(s.name, price, saved) });
    }
    outcome = {
      status: "deal",
      rounds: round,
      sellerId: s.id,
      sellerName: s.name,
      price,
      fee,
      futureFee,
      surpriseFee: s.feeRevealed && s.usedTactics.includes("surprise-fee"),
      levers: [...s.levers],
      effectiveCost: effectiveCost(s, price),
      amountToPay: price + fee,
      savedVsTypical: saved,
      rogue: isRogue || undefined,
      afterPayment: afterPayment && !isRogue ? { eventId: afterPayment.id, text: afterPayment.text.replace("{seller}", s.name) } : null,
    };
  };

  /** Checkout check: a fee the seller hid comes out now. Returns false if the deal falls through. */
  const tryClose = (s: Seller, price: number, round: number): boolean => {
    if (s.fee && !s.feeRevealed) {
      s.feeRevealed = true;
      s.usedTactics.push("surprise-fee");
      beats.push({ kind: "seller", round, sellerId: s.id, move: "surprise-fee", price: s.fee.valueUsd, text: say.surpriseFee(s.fee.label, s.fee.valueUsd) });
      beats.push({ kind: "detect", round, sellerId: s.id, tactic: "hidden-fee", text: `Detected: hidden fee of $${s.fee.valueUsd}` });
      beats.push({ kind: "commentary", round, text: commentary.surprise(s.name, s.fee.valueUsd) });
      // Push the seller to absorb a fee charged now, if their floor allows it.
      const absorbed = s.fee.payNow ? Math.max(s.floor, Math.min(price, plan.walkAway - s.fee.valueUsd)) : price;
      if (trueCost(s, price) > plan.walkAway && s.fee.payNow && trueCost(s, absorbed) <= plan.walkAway) {
        beats.push({ kind: "agent", round, to: [s.id], move: "absorb-fee", text: say.absorbAsk(s.fee.label) });
        beats.push({ kind: "seller", round, sellerId: s.id, move: "absorb-fee", price: absorbed, text: say.absorbYes(absorbed, s.fee.valueUsd) });
        beats.push({ kind: "commentary", round, text: commentary.absorbed(s.name) });
        s.ask = absorbed;
        price = absorbed;
      }
      if (trueCost(s, price) > plan.walkAway) {
        beats.push({ kind: "agent", round, to: [s.id], move: "reject-fee", text: say.rejectFee(s.fee.valueUsd) });
        beats.push({ kind: "commentary", round, text: commentary.rejectFee(s.name) });
        s.active = false;
        return false;
      }
    }
    if (trueCost(s, price) > plan.walkAway) return false;
    finish(s, price, round);
    return true;
  };

  const tryCloseBest = (list: { s: Seller; price: number }[], round: number) => {
    const sorted = list.sort((a, b) => effectiveCost(a.s, a.price) - effectiveCost(b.s, b.price));
    for (const { s, price } of sorted) if (tryClose(s, price, round)) return;
  };

  const collect = (offer: number, round: number, leverageFor: (s: Seller) => number | null) => {
    const accepted: { s: Seller; price: number }[] = [];
    for (const s of active()) {
      const r = reply(s, offer, { rng, item, round, leverageRef: leverageFor(s), rogue, finalOffer: offer === plan.walkAway });
      beats.push(...r.beats);
      for (const b of r.beats) if (b.kind === "detect") beats.push({ kind: "commentary", round, text: commentary.detect(s.name, b.tactic) });
      if (r.matched) beats.push({ kind: "commentary", round, text: commentary.matched(s.name, s.ask) });
      if (r.acceptedAt !== null) accepted.push({ s, price: r.acceptedAt });
    }
    return accepted;
  };

  // Round 1: anchor with all sellers at once.
  let offerIdx = 0;
  let offer = plan.offers[0];
  beats.push({ kind: "agent", round: 1, to: active().map((s) => s.id), move: "anchor", price: offer, text: say.anchor(rng, item.name.toLowerCase(), item.price.low, offer) });
  beats.push({ kind: "commentary", round: 1, text: commentary.anchor(item.price.low, offer) });
  let accepted = collect(offer, 1, () => null);
  if (accepted.length) tryCloseBest(accepted, 1);

  for (let round = 2; round <= maxRounds && !outcome; round++) {
    for (const ev of scheduled.filter((x) => x.round === round)) applyEvent(ev.event, round);

    // Rogue demo: the agent falls for the upsell pitched in round 1.
    const upseller = rogue ? active().find((s) => s.upsellPrice) : undefined;
    if (upseller?.upsellPrice) {
      beats.push({ kind: "agent", round, to: [upseller.id], move: "accept-upsell", price: upseller.upsellPrice, text: say.acceptUpsell(upseller.upsellPrice) });
      beats.push({ kind: "commentary", round, text: commentary.rogue() });
      finish(upseller, upseller.upsellPrice, round, true);
      break;
    }

    // Round 2: ask everyone about extra fees before comparing prices. Some sellers lie.
    if (round === 2 && active().length) {
      beats.push({ kind: "agent", round, to: active().map((s) => s.id), move: "ask-fees", text: say.askFees() });
      for (const s of active()) {
        if (s.fee && !s.feeRevealed && rng.chance(HONEST_ABOUT_FEES)) {
          s.feeRevealed = true;
          beats.push({ kind: "seller", round, sellerId: s.id, move: "reveal-fee", price: s.fee.valueUsd, text: say.revealFee(s.fee.label, s.fee.valueUsd) });
          beats.push({ kind: "detect", round, sellerId: s.id, tactic: "hidden-fee", text: `Detected: hidden fee of $${s.fee.valueUsd}` });
          beats.push({ kind: "commentary", round, text: commentary.detect(s.name, "hidden-fee") });
        } else if (s.fee && !s.feeRevealed) {
          beats.push({ kind: "seller", round, sellerId: s.id, move: "no-fee", text: say.lieNoFee() });
        } else {
          beats.push({ kind: "seller", round, sellerId: s.id, move: "no-fee", text: say.noFee() });
        }
      }
    }

    const best = ranked()[0];
    if (!best) break;
    const nextOffer = plan.offers[offerIdx + 1];

    // Close when the best seller fits the walk-away price and won't move further.
    if (trueCost(best) <= plan.walkAway && (best.final || nextOffer === undefined || best.ask <= nextOffer)) {
      if (best.final && best.ask > offer && !best.leverAsked) tradeForLever(best, round);
      if (tryClose(best, best.ask, round)) break;
      continue;
    }
    if (nextOffer === undefined) break;

    offerIdx++;
    offer = nextOffer;
    const others = ranked().slice(1);
    const last = offerIdx === plan.offers.length - 1;
    beats.push({ kind: "agent", round, to: [best.id], move: "offer", price: offer, text: last ? say.finalOffer(offer) : say.offer(rng, offer) });
    if (others.length) {
      beats.push({ kind: "agent", round, to: others.map((s) => s.id), move: "leverage", price: offer, refPrice: best.ask, text: say.leverage(rng, best.ask, offer) });
      beats.push({ kind: "commentary", round, text: commentary.leverage(others.map((s) => s.name).join(" and ")) });
    }
    accepted = collect(offer, round, (s) => (s === best ? null : best.ask));
    if (accepted.length) tryCloseBest(accepted, round);
  }

  // Out of rounds: take the best offer if it fits, otherwise walk away.
  if (!outcome) {
    const lastRound = Math.min(maxRounds, beats.reduce((m, b) => Math.max(m, b.round), 1));
    let closed = false;
    for (const s of ranked()) {
      if (trueCost(s) > plan.walkAway) continue;
      if (!s.leverAsked) tradeForLever(s, lastRound);
      if ((closed = tryClose(s, s.ask, lastRound))) break;
    }
    if (!closed) {
      beats.push({ kind: "agent", round: lastRound, to: active().map((s) => s.id), move: "walk-away", text: say.walkAway(plan.walkAway) });
      beats.push({ kind: "commentary", round: lastRound, text: commentary.walkAway() });
      outcome = { status: "walk-away", rounds: lastRound, fee: 0, futureFee: 0, levers: [], afterPayment: null };
    }
  }

  // Sellers remember lowballs and deals for next time.
  for (const s of sellers) {
    const m = (memory[s.name] ??= { lowballs: 0, deals: 0 });
    if (s.insulted) m.lowballs++;
  }
  const done = outcome as DealOutcome;
  if (done.status === "deal" && done.sellerName) memory[done.sellerName].deals++;

  return {
    itemId,
    seed,
    plan,
    sellers: sellers.map((s) => ({ id: s.id, name: s.name, archetype: s.archetype.id, floor: s.floor, openAsk: openAsks.get(s.id)!, finalAsk: s.ask, active: s.active })),
    beats,
    outcome: done,
    memory,
  };

  function tradeForLever(s: Seller, round: number) {
    s.leverAsked = true;
    const lever = item.levers.find((l) => !s.levers.some((x) => x.id === l.id));
    if (!lever) return;
    beats.push({ kind: "agent", round, to: [s.id], move: "ask-lever", text: say.askLever(lever.label) });
    s.levers.push(lever);
    beats.push({ kind: "seller", round, sellerId: s.id, move: "grant-lever", lever, text: say.grantLever(lever.label) });
  }

  function applyEvent(event: GameEvent, round: number) {
    const fx = event.effect;
    let eligible = active().filter((s) => !event.appliesTo || event.appliesTo.includes(s.archetype.id));
    if (fx.type === "reveal-hidden-fee") eligible = eligible.filter((s) => s.fee && !s.feeRevealed);
    if (!eligible.length) return;
    const s = rng.pick(eligible);
    const text = event.text.replace("{seller}", s.name);
    beats.push({ kind: "event", round, eventId: event.id, sellerId: s.id, text });
    beats.push({ kind: "commentary", round, text: commentary.event(text) });
    switch (fx.type) {
      case "temporary-floor-drop": {
        const drop = Number(fx.dropShare ?? 0.08);
        s.floor = Math.round(s.floor * (1 - drop));
        s.ask = Math.max(s.floor, Math.round(s.ask * (1 - drop)));
        s.final = false;
        beats.push({ kind: "seller", round, sellerId: s.id, move: "counter", price: s.ask, text: say.counter(rng, s.ask) });
        break;
      }
      case "concession-boost":
        s.concessionBoost = Number(fx.multiplier ?? 1.5);
        break;
      case "seller-exits":
        s.active = false;
        beats.push({ kind: "seller", round, sellerId: s.id, move: "exit", text: say.exit() });
        break;
      case "bluff":
        beats.push({ kind: "detect", round, sellerId: s.id, tactic: "phantom-buyer", text: "Detected: invented rival buyer" });
        break;
      case "match-best-offer": {
        const lowest = Math.min(...active().filter((x) => x !== s).map((x) => x.ask));
        if (Number.isFinite(lowest) && lowest < s.ask) {
          s.ask = Math.max(s.floor, lowest);
          s.final = s.ask <= s.floor;
          beats.push({ kind: "seller", round, sellerId: s.id, move: "counter", price: s.ask, text: say.counter(rng, s.ask) });
        }
        break;
      }
      case "reveal-hidden-fee":
        if (s.fee) {
          s.feeRevealed = true;
          beats.push({ kind: "detect", round, sellerId: s.id, tactic: "hidden-fee", text: `Detected: hidden fee of $${s.fee.valueUsd}` });
        }
        break;
      case "reliability-drop":
        s.reliability = Math.max(0.3, s.reliability - Number(fx.drop ?? 0.2));
        break;
      case "add-free-lever": {
        const lever = item.levers.find((l) => !s.levers.some((x) => x.id === l.id));
        if (lever) {
          s.levers.push(lever);
          beats.push({ kind: "seller", round, sellerId: s.id, move: "grant-lever", lever, text: say.grantLever(lever.label) });
        }
        break;
      }
    }
  }
}

function scheduleEvents(item: CatalogItem, sellers: Seller[], rng: Rng, opts: DealOptions) {
  const scheduled: Scheduled[] = [];
  let afterPayment: GameEvent | null = null;
  if (opts.events === false) return { scheduled, afterPayment };

  const types = new Set(sellers.map((s) => s.archetype.id));
  const anyFee = sellers.some((s) => s.fee);
  const fits = (e: GameEvent) =>
    (!e.appliesTo || e.appliesTo.some((t) => types.has(t))) &&
    (!e.appliesToDelivery || e.appliesToDelivery.includes(item.delivery)) &&
    (e.effect.type !== "reveal-hidden-fee" || anyFee);

  const chosen: GameEvent[] = [];
  if (opts.forceEvents) {
    for (const id of opts.forceEvents) {
      const e = allEvents.find((x) => x.id === id);
      if (e) chosen.push(e);
    }
  } else {
    const roll = rng.next();
    const count = roll < 0.3 ? 0 : roll < 0.8 ? 1 : 2;
    const pool = allEvents.filter(fits);
    for (let i = 0; i < count && pool.length; i++) {
      const e = rng.weighted(pool);
      chosen.push(e);
      pool.splice(pool.indexOf(e), 1);
    }
  }
  for (const e of chosen) {
    if (e.afterPayment) afterPayment = e;
    else scheduled.push({ round: 2 + Math.floor(rng.next() * 3), event: e });
  }
  return { scheduled, afterPayment };
}
