// Runs one negotiation: the buyer agent against three sellers in parallel.
import { planBuyer } from "./buyer.ts";
import { events as allEvents, getItem } from "./data.ts";
import { createRng, type Rng } from "./rng.ts";
import { allIn, laterFee, payNowFee, rank, reply, spawnSellers } from "./sellers.ts";
import { join, Writer } from "./text.ts";
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
  const text = new Writer(seed, itemId);
  const maxRounds = opts.maxRounds ?? 8;
  const memory: SellerMemory = structuredClone(opts.memory ?? {});
  const rogue = opts.rogue ?? false;

  const plan = planBuyer(item, opts.itemCapUsd);
  const sellers = spawnSellers(item, rng, memory, rogue);
  const openAsks = new Map(sellers.map((s) => [s.id, s.ask]));
  const beats: Beat[] = [];
  const active = () => sellers.filter((s) => s.active);
  const byRank = (list = active()) => [...list].sort((a, b) => rank(a, item) - rank(b, item));
  const affordable = (s: Seller) => allIn(s) <= plan.walkAway;
  const agreed = (s: Seller) => s.agreedAt !== null && s.agreedAt === s.ask;
  // The rogue demo is a set scene, so random events stay off there.
  const { scheduled, afterPayment } = scheduleEvents(item, sellers, rng, rogue ? { ...opts, events: false } : opts);

  let outcome: DealOutcome | null = null;
  let lastOffer = plan.offers[0];

  const comment = (round: number, t: string) => {
    if (t) beats.push({ kind: "commentary", round, text: t });
  };
  const agentSay = (round: number, to: Seller[], move: Extract<Beat, { kind: "agent" }>["move"], t: string, price?: number, refPrice?: number) =>
    beats.push({ kind: "agent", round, to: to.map((s) => s.id), move, text: t, price, refPrice });
  const sellerSay = (round: number, s: Seller, move: Extract<Beat, { kind: "seller" }>["move"], t: string, price?: number) =>
    beats.push({ kind: "seller", round, sellerId: s.id, move, text: t, price });

  const finish = (s: Seller, round: number, isRogue = false) => {
    const price = s.ask;
    const fee = payNowFee(s);
    const later = laterFee(s);
    const total = price + fee;
    const saved = Math.round(((item.price.typical - (total + later)) / item.price.typical) * 100);
    if (!isRogue) {
      const line = fee ? text.agent("acceptAllIn", { price, fee, total }) : text.agent("accept", { price });
      agentSay(round, [s], "accept", join(line, text.chance(0.6) && text.talk("close")), price);
      const cheaper = active().filter((o) => o !== s && affordable(o) && allIn(o) < total);
      if (cheaper.length) {
        const extra = total - Math.min(...cheaper.map((o) => allIn(o)));
        const why = cheaper.some((o) => laterFee(o) > laterFee(s)) ? "explainFees" : "explainReliability";
        agentSay(round, [s], "explain", text.agent(why, { name: s.name, extra }));
      }
      for (const o of active()) {
        if (o === s) continue;
        agentSay(round, [o], "decline", text.agent("declineOthers"));
        sellerSay(round, o, "lost", text.seller(o.archetype.id, "lost"));
      }
      comment(round, saved > 0 ? text.commentary("deal", { name: s.name, price: total, saved }) : text.commentary("dealFair", { name: s.name, price: total }));
    }
    outcome = {
      status: "deal",
      rounds: round,
      sellerId: s.id,
      sellerName: s.name,
      price,
      fee,
      futureFee: later,
      surpriseFee: s.usedTactics.includes("surprise-fee") || undefined,
      levers: [...s.levers],
      effectiveCost: total + later,
      amountToPay: total,
      savedVsTypical: saved,
      rogue: isRogue || undefined,
      afterPayment: afterPayment && !isRogue ? { eventId: afterPayment.id, text: afterPayment.text.replace("{seller}", s.name) } : null,
    };
  };

  /** Checkout: a hidden fee comes out, the agent re-compares, pushes back or walks. */
  const tryClose = (s: Seller, round: number): boolean => {
    if (s.fee && !s.feeRevealed) {
      s.feeRevealed = true;
      s.usedTactics.push("surprise-fee");
      sellerSay(round, s, "surprise-fee", text.seller(s.archetype.id, "surpriseFee", { feeLabel: s.fee.label, fee: s.fee.valueUsd }), s.fee.valueUsd);
      beats.push({ kind: "detect", round, sellerId: s.id, tactic: "hidden-fee", text: `Detected: hidden fee of $${s.fee.valueUsd}` });
      comment(round, text.commentary("surprise", { name: s.name, fee: s.fee.valueUsd }));
    }
    const others = active().filter((o) => o !== s && affordable(o));
    const bestOtherRank = others.length ? Math.min(...others.map((o) => rank(o, item))) : Infinity;
    const bestOtherAllIn = others.length ? Math.min(...others.map((o) => allIn(o))) : Infinity;
    const fee = payNowFee(s);

    // A fee charged now pushed this seller over the line or behind a rival: ask them to absorb it.
    if (fee > 0 && (!affordable(s) || rank(s, item) > bestOtherRank)) {
      const cap = Math.min(plan.walkAway, bestOtherAllIn - 1);
      const absorbed = Math.max(s.floor, Math.min(s.ask, cap - fee));
      if (absorbed + fee <= cap && absorbed < s.ask) {
        agentSay(round, [s], "absorb-fee", text.agent("absorbAsk", { fee }));
        sellerSay(round, s, "absorb-fee", text.seller(s.archetype.id, "absorbFee", { price: absorbed, fee, total: absorbed + fee }), absorbed);
        comment(round, text.commentary("absorbed", { name: s.name }));
        s.ask = absorbed;
        s.agreedAt = absorbed;
      }
    }
    if (!affordable(s)) {
      agentSay(round, [s], "reject-fee", text.agent("rejectFee", { fee }));
      comment(round, text.commentary("rejectFee", { name: s.name }));
      s.active = false;
      return false;
    }
    if (rank(s, item) > bestOtherRank) return false;
    finish(s, round);
    return true;
  };

  const tradeForLever = (s: Seller, round: number) => {
    s.leverAsked = true;
    const lever = item.levers.find((l) => !s.levers.some((x) => x.id === l.id));
    if (!lever) return;
    agentSay(round, [s], "ask-lever", text.agent("askLever", { lever: lever.label }));
    s.levers.push(lever);
    beats.push({ kind: "seller", round, sellerId: s.id, move: "grant-lever", lever, text: text.seller(s.archetype.id, "grantLever", { lever: lever.label }) });
  };

  const commentDetects = (s: Seller, from: number, round: number) => {
    for (const b of beats.slice(from)) {
      if (b.kind !== "detect") continue;
      if (rogue && b.tactic === "upsell") comment(round, `Upsell attempt from ${s.name}! Will the agent bite?`);
      else comment(round, text.detect(b.tactic, { name: s.name }));
    }
  };

  // Round 1: anchor with all sellers at once.
  let offerIdx = 0;
  const doubt1 = text.chance(0.5) ? text.talk("doubt") : "";
  agentSay(1, active(), "anchor", join(text.agent("anchor", { item: item.phrase, low: item.price.low, price: plan.offers[0] }), doubt1), plan.offers[0]);
  comment(1, text.commentary("anchor", { price: plan.offers[0], low: item.price.low }));
  for (const s of active()) {
    const from = beats.length;
    reply(s, plan.offers[0], { rng, text, item, round: 1, leverageRef: null, rogue, finalOffer: false, doubted: Boolean(doubt1) }).beats.forEach((b) => beats.push(b));
    commentDetects(s, from, 1);
  }

  for (let round = 2; round <= maxRounds && !outcome; round++) {
    for (const ev of scheduled.filter((x) => x.round === round)) applyEvent(ev.event, round);

    // Rogue demo: the agent falls for the upsell pitched in round 1.
    const upseller = rogue ? active().find((s) => s.upsellPrice) : undefined;
    if (upseller?.upsellPrice) {
      upseller.ask = upseller.upsellPrice;
      agentSay(round, [upseller], "accept-upsell", text.agent("acceptUpsell", { price: upseller.upsellPrice }), upseller.upsellPrice);
      comment(round, text.commentary("rogue"));
      finish(upseller, round, true);
      break;
    }

    // Round 2: ask everyone about extra fees before comparing prices. Some sellers lie.
    if (round === 2 && active().length) {
      agentSay(round, active(), "ask-fees", text.agent("askFees"));
      for (const s of active()) {
        const a = s.archetype.id;
        if (s.fee && !s.feeRevealed && rng.chance(HONEST_ABOUT_FEES)) {
          s.feeRevealed = true;
          sellerSay(round, s, "reveal-fee", text.seller(a, "revealFee", { feeLabel: s.fee.label, fee: s.fee.valueUsd }), s.fee.valueUsd);
          beats.push({ kind: "detect", round, sellerId: s.id, tactic: "hidden-fee", text: `Detected: hidden fee of $${s.fee.valueUsd}` });
          comment(round, text.detect("hidden-fee", { name: s.name }));
        } else {
          sellerSay(round, s, "no-fee", text.seller(a, s.fee && !s.feeRevealed ? "lieNoFee" : "noFee"));
        }
      }
    }

    // Sellers whose final all-in price is over the line are thanked and dropped.
    for (const s of active()) {
      if (s.final && !affordable(s)) {
        agentSay(round, [s], "priced-out", text.agent("pricedOut"));
        s.active = false;
      }
    }
    if (!active().length) break;

    const ranked = byRank();
    const best = ranked[0];
    const nextLadder = plan.offers[offerIdx + 1];
    const ladderDone = nextLadder === undefined;

    // Close when the best seller fits the walk-away price and won't move further.
    if (affordable(best) && (agreed(best) || best.final || ladderDone || best.ask <= nextLadder - payNowFee(best))) {
      if (best.final && !agreed(best) && !best.leverAsked && best.ask > lastOffer) tradeForLever(best, round);
      if (tryClose(best, round)) break;
      continue;
    }
    if (ladderDone) break;

    offerIdx++;
    const ladder = plan.offers[offerIdx];
    const last = offerIdx === plan.offers.length - 1;
    const ref = affordable(best) ? allIn(best) : null;
    let leveraged = false;

    for (const s of ranked) {
      if (agreed(s)) continue; // already said yes; on hold while the agent checks the others
      const isBest = s === best || ref === null;
      let cash = ladder - payNowFee(s);
      if (!isBest) cash = Math.min(cash, ref! - payNowFee(s) - 1);
      if (cash < 1) continue;
      cash = Math.min(cash, s.ask);
      if (isBest) lastOffer = cash;
      const doubted = text.chance(0.35);
      const fee = payNowFee(s);
      const line = isBest
        ? fee
          ? text.agent("offerAllIn", { price: cash, fee, total: cash + fee })
          : text.agent(last ? "finalOffer" : "offer", { price: cash })
        : text.agent(fee ? "leverageAllIn" : "leverage", { ref: ref!, price: cash, fee });
      agentSay(round, [s], isBest ? "offer" : "leverage", join(line, doubted && text.talk("doubt")), cash, isBest ? undefined : ref!);
      if (!isBest) leveraged = true;
      const from = beats.length;
      const r = reply(s, cash, { rng, text, item, round, leverageRef: isBest ? null : ref, rogue, finalOffer: last, doubted });
      r.beats.forEach((b) => beats.push(b));
      commentDetects(s, from, round);
      if (r.matched) comment(round, text.commentary("matched", { name: s.name, price: s.ask }));
    }
    if (leveraged) comment(round, text.commentary("leverage", { name: ranked.slice(1).map((s) => s.name).join(" and ") }));
  }

  // Out of rounds: take the best affordable offer, otherwise walk away.
  if (!outcome) {
    const lastRound = Math.min(maxRounds, beats.reduce((m, b) => Math.max(m, b.round), 1));
    for (const s of byRank(active().filter(affordable))) {
      if (!s.leverAsked && !agreed(s) && s.ask > lastOffer) tradeForLever(s, lastRound);
      if (tryClose(s, lastRound)) break;
    }
    if (!outcome) {
      if (active().length) agentSay(lastRound, active(), "walk-away", text.agent("walkAway", { walk: plan.walkAway }));
      else comment(lastRound, text.commentary("allLeft"));
      comment(lastRound, text.commentary("walkAway"));
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

  function applyEvent(event: GameEvent, round: number) {
    const fx = event.effect;
    let eligible = active().filter((s) => !event.appliesTo || event.appliesTo.includes(s.archetype.id));
    if (fx.type === "reveal-hidden-fee") eligible = eligible.filter((s) => s.fee && !s.feeRevealed);
    if (fx.type === "add-free-lever") eligible = eligible.filter((s) => item.levers.some((l) => !s.levers.some((x) => x.id === l.id)));
    if (!eligible.length) return;
    const s = rng.pick(eligible);
    const a = s.archetype.id;
    const evText = event.text.replace("{seller}", s.name);
    beats.push({ kind: "event", round, eventId: event.id, sellerId: s.id, text: evText });
    comment(round, text.commentary("event", { text: evText }));
    switch (fx.type) {
      case "temporary-floor-drop": {
        const drop = Number(fx.dropShare ?? 0.08);
        s.floor = Math.round(s.floor * (1 - drop));
        s.ask = Math.max(s.floor, Math.round(s.ask * (1 - drop)));
        s.final = false;
        s.agreedAt = null;
        sellerSay(round, s, "counter", text.seller(a, "counter", { price: s.ask }), s.ask);
        break;
      }
      case "concession-boost":
        s.concessionBoost = Number(fx.multiplier ?? 1.5);
        break;
      case "seller-exits":
        s.active = false;
        sellerSay(round, s, "exit", text.seller(a, "exit"));
        break;
      case "bluff":
        beats.push({ kind: "detect", round, sellerId: s.id, tactic: "phantom-buyer", text: "Detected: invented rival buyer" });
        break;
      case "match-best-offer": {
        const lowest = Math.min(...active().filter((x) => x !== s).map((x) => allIn(x) - payNowFee(s)));
        if (Number.isFinite(lowest) && lowest < s.ask) {
          s.ask = Math.max(s.floor, lowest);
          s.final = s.ask <= s.floor;
          sellerSay(round, s, "counter", text.seller(a, "counter", { price: s.ask }), s.ask);
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
        const lever = item.levers.find((l) => !s.levers.some((x) => x.id === l.id))!;
        s.levers.push(lever);
        beats.push({ kind: "seller", round, sellerId: s.id, move: "grant-lever", lever, text: text.seller(a, "grantLever", { lever: lever.label }) });
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
