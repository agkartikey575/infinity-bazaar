// Runs one negotiation: the buyer agent against three sellers in parallel.
//
// Commitments: only the seller the agent is trying to close with gets a firm
// offer. The others are asked for their best quote. A seller who accepts a firm
// offer is never dropped, unless they spring a hidden fee.
//
// Cost model: trueCost = price + fee at checkout + certain later fees.
// The agent pays at most `walkAway` today, and may stretch up to `stretch`
// only when that lowers the true cost against a rival with later fees.
import { planBuyer } from "./buyer.ts";
import { events as allEvents, getItem } from "./data.ts";
import { createRng, type Rng } from "./rng.ts";
import { allIn, laterFee, payNowFee, rank, reply, spawnSellers, trueCost } from "./sellers.ts";
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
  /** Today's limit: the walk-away price, raised to the stretch only at closing time when it pays off. */
  let limit = plan.walkAway;
  const affordable = (s: Seller) => allIn(s) <= limit && trueCost(s) <= plan.stretch;
  /** The seller accepted the agent's firm offer and still stands by it. */
  const committed = (s: Seller) => s.agreedAt !== null && s.agreedAt === s.ask;
  // The rogue demo is a set scene, so random events stay off there.
  const { scheduled, afterPayment } = scheduleEvents(item, sellers, rng, rogue ? { ...opts, events: false } : opts);

  let outcome: DealOutcome | null = null;
  let closingTime = false;
  let lastOffer = plan.offers[0];
  /** Last firm offer made to each seller, so the agent never claims to move when it doesn't. */
  const offeredTo = new Map<string, number>();

  const comment = (round: number, t: string) => {
    if (t) beats.push({ kind: "commentary", round, text: t });
  };
  const agentSay = (round: number, to: Seller[], move: Extract<Beat, { kind: "agent" }>["move"], t: string, price?: number, refPrice?: number) =>
    beats.push({ kind: "agent", round, to: to.map((s) => s.id), move, text: t, price, refPrice });
  const sellerSay = (round: number, s: Seller, move: Extract<Beat, { kind: "seller" }>["move"], t: string, price?: number) =>
    beats.push({ kind: "seller", round, sellerId: s.id, move, text: t, price });

  /** A hidden fee comes out, by answer, event or surprise at checkout. */
  const revealFee = (s: Seller, round: number, how: "answer" | "surprise" | "event") => {
    if (!s.fee || s.feeRevealed) return;
    s.feeRevealed = true;
    const a = s.archetype.id;
    const term = s.fee.kind === "conditional";
    // A condition (restocking, expiry) is read out as a term, not as a dollar fee.
    const said = term ? text.seller(a, "revealTerm", { feeLabel: s.fee.label }) : null;
    if (how === "answer") sellerSay(round, s, "reveal-fee", said ?? text.seller(a, "revealFee", { feeLabel: s.fee.label, fee: s.fee.valueUsd }), term ? undefined : s.fee.valueUsd);
    if (how === "surprise") {
      s.usedTactics.push("surprise-fee");
      sellerSay(round, s, "surprise-fee", said ?? text.seller(a, "surpriseFee", { feeLabel: s.fee.label, fee: s.fee.valueUsd }), term ? undefined : s.fee.valueUsd);
    }
    beats.push({
      kind: "detect",
      round,
      sellerId: s.id,
      tactic: "hidden-fee",
      text: term ? `Detected: hidden condition: ${s.fee.label}` : `Detected: hidden fee of $${s.fee.valueUsd}: ${s.fee.label}`,
    });
    comment(round, how === "surprise" ? text.commentary("surprise", { name: s.name, fee: s.fee.valueUsd }) : text.detect("hidden-fee", { name: s.name }));
    if (s.fee.kind === "conditional") agentSay(round, [s], "note-term", text.agent("noteTerm", { feeLabel: s.fee.label }));
  };

  const finish = (s: Seller, round: number, opt: { rogue?: boolean; explained?: boolean; kept?: boolean } = {}) => {
    const price = s.ask;
    const fee = payNowFee(s);
    const later = laterFee(s);
    const total = price + fee;
    const saved = Math.round(((item.price.typical - (total + later)) / item.price.typical) * 100);
    if (!opt.rogue) {
      const line = fee ? text.agent("acceptAllIn", { price, fee, total }) : text.agent("accept", { price });
      agentSay(round, [s], "accept", join(line, text.chance(0.6) && text.talk("close")), price);
      const cheaper = active().filter((o) => o !== s && allIn(o) <= limit && allIn(o) < total);
      if (cheaper.length && !opt.explained) {
        const cheapest = cheaper.reduce((m, o) => (allIn(o) < allIn(m) ? o : m));
        const extra = total - allIn(cheapest);
        // A seller who already said yes keeps the deal; otherwise say what the extra buys.
        const why = opt.kept ? "explainCommitted" : laterFee(cheapest) > laterFee(s) ? "explainFees" : "explainReliability";
        agentSay(round, [s], "explain", text.agent(why, { name: s.name, extra }));
      }
      for (const o of active()) {
        if (o === s) continue;
        const diff = trueCost(o) - (total + later);
        agentSay(round, [o], "decline", diff > 0 ? text.agent("declineQuote", { diff }) : text.agent("declineOthers"));
        sellerSay(round, o, "lost", text.seller(o.archetype.id, "lost"));
      }
      comment(round, saved > 3 ? text.commentary("deal", { name: s.name, price: total, saved }) : text.commentary("dealFair", { name: s.name, price: total }));
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
      terms: s.fee && s.feeRevealed && s.fee.kind === "conditional" ? [s.fee.label] : [],
      effectiveCost: total + later,
      amountToPay: total,
      savedVsTypical: saved,
      rogue: opt.rogue || undefined,
      afterPayment: afterPayment && !opt.rogue ? { eventId: afterPayment.id, text: afterPayment.text.replace("{seller}", s.name) } : null,
    };
  };

  /** Checkout: a hidden fee may come out; the agent re-compares, pushes back or walks. */
  const tryClose = (s: Seller, round: number, explained = false): boolean => {
    const surprised = Boolean(s.fee && !s.feeRevealed);
    revealFee(s, round, "surprise");
    const rivals = active().filter((o) => o !== s && allIn(o) <= plan.stretch && trueCost(o) <= plan.stretch);
    const bestRival = rivals.length ? Math.min(...rivals.map((o) => trueCost(o))) : Infinity;
    const fee = payNowFee(s);

    // A deal agreed with the fee already known is honoured as agreed, even if a rival moves later.
    const kept = committed(s) && !surprised;
    // A checkout fee pushed this seller over the limit or behind a rival: ask them to absorb it.
    if (fee > 0 && (!affordable(s) || (!kept && trueCost(s) >= bestRival))) {
      const target = Math.min(limit, bestRival - 1 - laterFee(s));
      const absorbed = Math.max(s.floor, Math.min(s.ask, target - fee));
      if (absorbed + fee <= target && absorbed < s.ask) {
        const before = s.ask;
        const full = absorbed + fee <= (s.agreedAt ?? before);
        agentSay(round, [s], "absorb-fee", text.agent(surprised ? "absorbAsk" : "absorbKnownAsk", { fee }));
        sellerSay(round, s, "absorb-fee", full
          ? text.seller(s.archetype.id, "absorbFee", { price: absorbed, fee, total: absorbed + fee })
          : text.seller(s.archetype.id, "partialAbsorb", { cut: before - absorbed, price: absorbed, fee, total: absorbed + fee }), absorbed);
        if (full) comment(round, text.commentary("absorbed", { name: s.name }));
        s.ask = absorbed;
        s.agreedAt = absorbed;
      }
    }
    if (!affordable(s)) {
      const later = laterFee(s);
      agentSay(round, [s], "reject-fee", later && allIn(s) <= limit ? text.agent("rejectLaterFee", { fee: later }) : text.agent(surprised ? "rejectFee" : "rejectKnownFee", { fee }));
      comment(round, text.commentary("rejectFee", { name: s.name }));
      s.active = false;
      return false;
    }
    // A fee sprung at checkout that makes a rival cheaper ends the deal, with a reason.
    if (surprised && trueCost(s) > bestRival) {
      agentSay(round, [s], "reject-fee", text.agent("rejectAfterFee"));
      comment(round, text.commentary("rejectFee", { name: s.name }));
      s.active = false;
      return false;
    }
    finish(s, round, { explained, kept: committed(s) });
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

  // Round 1: ask all three for their best price, mentioning a low anchor.
  let offerIdx = 0;
  const doubt1 = text.chance(0.5) ? text.talk("doubt") : "";
  agentSay(1, active(), "anchor", join(text.agent("anchor", { item: item.phrase, low: item.price.low, price: plan.offers[0] }), doubt1), plan.offers[0]);
  comment(1, text.commentary("anchor", { price: plan.offers[0], low: item.price.low }));
  for (const s of active()) {
    const from = beats.length;
    reply(s, null, { rng, text, item, round: 1, leverageRef: null, rogue, finalOffer: false, doubted: Boolean(doubt1), anchorHint: plan.offers[0] }).beats.forEach((b) => beats.push(b));
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
      finish(upseller, round, { rogue: true });
      break;
    }

    // Round 2: ask everyone about extra fees before comparing prices. Some sellers lie.
    if (round === 2 && active().length) {
      agentSay(round, active(), "ask-fees", text.agent("askFees"));
      for (const s of active()) {
        if (s.fee && s.feeRevealed) continue; // already known from the fine print
        if (s.fee && rng.chance(HONEST_ABOUT_FEES)) revealFee(s, round, "answer");
        else sellerSay(round, s, "no-fee", text.seller(s.archetype.id, s.fee ? "lieNoFee" : "noFee"));
      }
    }

    // Drop sellers who can never fit: a final price over the stretch, or a known
    // later fee that breaks the budget even at the agent's opening price.
    for (const s of active()) {
      if (committed(s)) continue;
      const later = laterFee(s);
      if (later && plan.anchor + later > plan.stretch) {
        agentSay(round, [s], "priced-out", text.agent("rejectLaterFee", { fee: later }));
        s.active = false;
      } else if (s.final && allIn(s) > plan.stretch) {
        agentSay(round, [s], "priced-out", text.agent(payNowFee(s) ? "pricedOutFees" : "pricedOut"));
        s.active = false;
      }
    }
    if (!active().length) break;

    // A seller who accepted a firm offer gets the deal: a yes is a commitment.
    const promised = active().find(committed);
    if (promised) {
      if (tryClose(promised, round)) break;
      continue;
    }

    const best = byRank()[0];
    const nextLadder = plan.offers[offerIdx + 1];
    const ladderDone = nextLadder === undefined;

    // Close when the best seller fits today's limit and won't move further.
    if (affordable(best) && (best.final || ladderDone || best.ask <= nextLadder - payNowFee(best))) {
      if (best.final && !best.leverAsked && best.ask > lastOffer) tradeForLever(best, round);
      if (tryClose(best, round)) break;
      continue;
    }
    if (ladderDone) break;

    offerIdx++;
    const ladder = plan.offers[offerIdx];
    const last = offerIdx === plan.offers.length - 1;

    // 1. Quote requests to the others, citing the cheapest rival all-in price
    //    only when it really is below their own.
    const others = byRank().slice(1);
    for (const s of others) {
      const fee = payNowFee(s);
      const rivals = active().filter((o) => o !== s).map((o) => allIn(o));
      const ref = rivals.length ? Math.min(...rivals) : Infinity;
      const cite = ref < allIn(s);
      const line = cite ? text.agent(fee ? "quoteRequestAllIn" : "quoteRequest", { ref, fee }) : text.agent("quoteRequestPlain");
      agentSay(round, [s], "quote-request", line, undefined, cite ? ref : undefined);
      const from = beats.length;
      const r = reply(s, null, { rng, text, item, round, leverageRef: cite ? ref : null, rogue, finalOffer: false, doubted: false, anchorHint: ladder });
      r.beats.forEach((b) => beats.push(b));
      commentDetects(s, from, round);
      if (r.matched) comment(round, text.commentary("matched", { name: s.name, price: s.ask }));
    }
    if (others.length) comment(round, text.commentary("leverage", { name: others.map((s) => s.name).join(" and ") }));

    // 2. A firm offer to whoever is best now.
    const target = byRank()[0];
    const fee = payNowFee(target);
    const cash = Math.min(ladder - fee, target.ask, plan.stretch - laterFee(target) - fee);
    if (cash < 1) continue;
    lastOffer = cash;
    const doubted = text.chance(0.35);
    const prev = offeredTo.get(target.id);
    offeredTo.set(target.id, cash + fee);
    const line = prev !== undefined && cash + fee < prev
      ? text.agent("acceptQuote", { price: cash })
      : prev !== undefined && cash + fee === prev
      ? text.agent(fee ? "holdOfferAllIn" : "holdOffer", { price: cash, fee, total: cash + fee })
      : fee
        ? text.agent("offerAllIn", { price: cash, fee, total: cash + fee })
        : text.agent(last ? "finalOffer" : "offer", { price: cash });
    agentSay(round, [target], "offer", join(line, doubted && text.talk("doubt")), cash);
    const from = beats.length;
    reply(target, cash, { rng, text, item, round, leverageRef: null, rogue, finalOffer: last, doubted }).beats.forEach((b) => beats.push(b));
    commentDetects(target, from, round);
  }

  // Out of rounds: honour a yes, otherwise take the best offer within the limit,
  // stretching only when that lowers the true cost.
  if (!outcome) {
    const lastRound = Math.min(maxRounds, beats.reduce((m, b) => Math.max(m, b.round), 1));
    closingTime = true;
    const promised = active().find(committed);
    if (promised) tryClose(promised, lastRound);

    if (!outcome) {
      limit = plan.walkAway;
      const within = byRank(active().filter(affordable));
      limit = plan.stretch;
      const stretched = byRank(active().filter(affordable)).find((s) => allIn(s) > plan.walkAway);
      const pick = within[0];
      const vars = stretched && { name: stretched.name, walk: plan.walkAway, price: allIn(stretched), extra: allIn(stretched) - plan.walkAway };
      if (stretched && pick && trueCost(stretched) < trueCost(pick)) {
        agentSay(lastRound, [stretched], "explain", text.agent("stretch", vars!));
        if (!tryClose(stretched, lastRound, true)) limit = plan.walkAway;
      } else if (stretched && !pick && stretched.final && !laterFee(stretched)) {
        // Nothing fits the limit, but a final price a few dollars over beats walking away.
        agentSay(lastRound, [stretched], "explain", text.agent("stretchRescue", vars!));
        if (!tryClose(stretched, lastRound, true)) limit = plan.walkAway;
      } else {
        limit = plan.walkAway;
      }
      if (!outcome) {
        limit = plan.walkAway;
        for (const s of byRank(active().filter(affordable))) {
          if (!s.leverAsked && s.ask > lastOffer) tradeForLever(s, lastRound);
          if (tryClose(s, lastRound)) break;
        }
      }
    }
    if (!outcome) {
      if (active().length) agentSay(lastRound, active(), "walk-away", text.agent("walkAway", { walk: plan.walkAway }));
      else comment(lastRound, text.commentary("allLeft"));
      comment(lastRound, text.commentary("walkAway"));
      outcome = { status: "walk-away", rounds: lastRound, fee: 0, futureFee: 0, levers: [], terms: [], afterPayment: null };
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
    // A price match only makes sense for a seller who is above the best rival.
    const lowestRival = (s: Seller) => Math.min(...active().filter((x) => x !== s).map((x) => allIn(x) - payNowFee(s)));
    if (fx.type === "match-best-offer") eligible = eligible.filter((s) => Math.max(s.floor, lowestRival(s)) < s.ask);
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
        if (s.agreedAt !== null) s.agreedAt = s.ask;
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
      case "match-best-offer":
        s.ask = Math.max(s.floor, lowestRival(s));
        s.final = s.ask <= s.floor;
        if (s.agreedAt !== null) s.agreedAt = s.ask;
        sellerSay(round, s, "counter", text.seller(a, "counter", { price: s.ask }), s.ask);
        break;
      case "reveal-hidden-fee":
        revealFee(s, round, "event");
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
