// Spawns randomized sellers for an item and decides how each one answers an offer.
import { getArchetype, sellerData } from "./data.ts";
import type { Rng } from "./rng.ts";
import { detectLabel, say } from "./text.ts";
import type { Beat, CatalogItem, Seller, SellerMemory } from "./types.ts";

export function spawnSellers(item: CatalogItem, rng: Rng, memory: SellerMemory = {}, forceUpseller = false): Seller[] {
  let types = rng.shuffle(item.sellerTypes).slice(0, 3);
  if (forceUpseller && !types.includes("upseller")) types = [...types.slice(0, 2), "upseller"];

  const usedNames = new Set<string>();
  return types.map((typeId, i) => {
    const archetype = getArchetype(typeId);
    const name = rng.shuffle(archetype.names).find((n) => !usedNames.has(n)) ?? archetype.names[0];
    usedNames.add(name);

    const [fMin, fMax] = item.seller.floorRange;
    const bias = Math.min(1, Math.max(0, archetype.floorBias + rng.range(-0.1, 0.1)));
    // A seller this buyer lowballed before is 3% firmer per insult, up to 9%.
    const grudge = 1 + Math.min(3, memory[name]?.lowballs ?? 0) * 0.03;
    const floor = Math.round((fMin + (fMax - fMin) * bias) * grudge);

    const open = Math.round(item.price.typical * rng.range(...archetype.openMarkup));
    const usesFees = archetype.tactics.includes("hidden-fee") || archetype.tactics.includes("teaser-price");

    return {
      id: `s${i + 1}`,
      name,
      archetype,
      floor,
      ask: Math.max(open, floor + 1),
      reliability: archetype.reliability,
      active: true,
      final: false,
      concessionBoost: 1,
      mood: 0,
      insulted: false,
      fee: usesFees && item.hiddenFees.length ? rng.pick(item.hiddenFees) : null,
      feeRevealed: false,
      levers: [],
      leverAsked: false,
      upsellPrice: null,
      usedTactics: [],
    };
  });
}

export interface ReplyContext {
  rng: Rng;
  item: CatalogItem;
  round: number;
  /** Best competing price the agent quoted to this seller, if any. */
  leverageRef: number | null;
  rogue: boolean;
  /** The agent said this is its last offer. */
  finalOffer: boolean;
}

export interface Reply {
  beats: Beat[];
  /** Price the seller accepted at, if they accepted the offer. */
  acceptedAt: number | null;
  matched: boolean;
}

const NO_TACTIC = new Set(["hidden-fee", "teaser-price"]);

export function reply(s: Seller, offer: number, ctx: ReplyContext): Reply {
  const { rng, item, round } = ctx;
  const beats: Beat[] = [];
  const closeEnough = Math.max(1, Math.round(item.price.typical * 0.03));

  // A final offer at or above the floor is usually taken; stubborn sellers sometimes hold out.
  const takesFinal = ctx.finalOffer && offer >= s.floor && rng.chance(s.archetype.concession === "slow" ? 0.65 : 0.9);
  if (offer >= s.ask || (offer >= s.floor && s.ask - offer <= closeEnough) || takesFinal) {
    s.ask = offer;
    beats.push({ kind: "seller", round, sellerId: s.id, move: "accept", price: offer, text: say.sellerAccept(rng, offer) });
    return { beats, acceptedAt: offer, matched: false };
  }

  if (offer < s.floor * 0.75 && !s.insulted) {
    s.insulted = true;
    s.mood -= 1;
  }

  // Concede a share of the typical price per round: slower when insulted,
  // faster as the rounds run out and the buyer might leave.
  const [cMin, cMax] = sellerData.concessionSpeed[s.archetype.concession];
  const urgency = 1 + (round - 1) * 0.25;
  const step = Math.max(1, item.price.typical * rng.range(cMin, cMax) * s.concessionBoost * urgency * (s.mood < 0 ? 0.5 : 1));
  let next = Math.max(s.floor, Math.round(s.ask - step));

  let matched = false;
  if (ctx.leverageRef !== null && ctx.leverageRef < next) {
    const base = { fast: 0.85, medium: 0.6, slow: 0.3 }[s.archetype.concession];
    const boost = s.archetype.softSpots.includes("competitor-offer") ? 1.25 : 1;
    if (rng.chance(base * boost)) {
      const undercut = s.archetype.concession === "fast" ? 2 : 1;
      const m = Math.max(s.floor, ctx.leverageRef - undercut);
      if (m < next) {
        next = m;
        matched = true;
      }
    }
  }

  s.ask = next;
  s.final = s.ask <= s.floor;
  beats.push({
    kind: "seller",
    round,
    sellerId: s.id,
    move: s.final ? "final" : "counter",
    price: s.ask,
    text: s.final ? say.final(rng, s.ask) : say.counter(rng, s.ask),
  });

  // Rogue demo: the upseller always pitches a premium bundle in round 1.
  const pitchUpsell = ctx.rogue && round === 1 && s.archetype.tactics.includes("upsell");
  if (pitchUpsell || (!s.final && rng.chance(0.3))) {
    const options = s.archetype.tactics.filter((t) => !NO_TACTIC.has(t) && !s.usedTactics.includes(t));
    const tactic = pitchUpsell ? "upsell" : options.length ? rng.pick(options) : null;
    if (tactic && !s.usedTactics.includes(tactic)) {
      s.usedTactics.push(tactic);
      if (tactic === "upsell") s.upsellPrice = Math.round(item.price.typical * rng.range(2.2, 2.7));
      beats.push({
        kind: "seller",
        round,
        sellerId: s.id,
        move: "tactic",
        tactic,
        price: tactic === "upsell" ? s.upsellPrice ?? undefined : undefined,
        text: say.tactic(rng, tactic, s.upsellPrice ?? undefined),
      });
      if (sellerData.detectable.includes(tactic)) {
        beats.push({ kind: "detect", round, sellerId: s.id, tactic, text: `Detected: ${detectLabel[tactic] ?? tactic}` });
      }
    }
  }
  return { beats, acceptedAt: null, matched };
}

/** Price + known fees − value of levers won. Compares sellers like for like. */
export function effectiveCost(s: Seller, price = s.ask): number {
  const fee = s.fee && s.feeRevealed ? s.fee.valueUsd : 0;
  return price + fee - s.levers.reduce((sum, l) => sum + l.valueUsd, 0);
}

/** Price + known fees, without counting extras. What the deal really costs. */
export function trueCost(s: Seller, price = s.ask): number {
  return price + (s.fee && s.feeRevealed ? s.fee.valueUsd : 0);
}

/** Cost adjusted for delivery risk, used to rank sellers. */
export function riskAdjusted(s: Seller, item: CatalogItem): number {
  const cost = effectiveCost(s);
  return item.delivery === "instant" ? cost : cost / Math.max(0.5, s.reliability);
}
