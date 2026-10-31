// Spawns randomized sellers for an item and decides how each one answers an offer.
import { getArchetype, sellerData } from "./data.ts";
import type { Rng } from "./rng.ts";
import { join, type Writer } from "./text.ts";
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
      agreedAt: null,
    };
  });
}

/** Fee charged at checkout that the buyer knows about. */
export const payNowFee = (s: Seller) => (s.fee && s.feeRevealed && s.fee.payNow ? s.fee.valueUsd : 0);
/** Certain later fee (a renewal, a usage fee) that the buyer knows about. Conditions don't count. */
export const laterFee = (s: Seller) => (s.fee && s.feeRevealed && s.fee.kind === "later" ? s.fee.valueUsd : 0);
/** What the deal really costs: price, checkout fee and certain later fees. */
export const trueCost = (s: Seller, price = s.ask) => allIn(s, price) + laterFee(s);
/** What the buyer pays now: price plus any known checkout fee. */
export const allIn = (s: Seller, price = s.ask) => price + payNowFee(s);

/**
 * The one ranking used everywhere: all-in price plus known later fees,
 * divided by delivery reliability for anything that isn't delivered instantly.
 * Extras won are a bonus and never offset cash.
 */
export function rank(s: Seller, item: CatalogItem, price = s.ask): number {
  const cost = trueCost(s, price);
  return item.delivery === "instant" ? cost : cost / Math.max(0.5, s.reliability);
}

export interface ReplyContext {
  rng: Rng;
  text: Writer;
  item: CatalogItem;
  round: number;
  /** Best competing all-in price the agent quoted to this seller, if any. */
  leverageRef: number | null;
  rogue: boolean;
  /** The agent said this is its last offer. */
  finalOffer: boolean;
  /** The agent raised an item-specific doubt with this offer. */
  doubted: boolean;
  /** Price the agent mentioned with a quote request, used to judge a lowball. */
  anchorHint?: number;
}

export interface Reply {
  beats: Beat[];
  /** Price the seller accepted at, if they accepted the offer. */
  acceptedAt: number | null;
  matched: boolean;
}

const NO_TACTIC = new Set(["hidden-fee", "teaser-price"]);

export const DETECT_LABEL: Record<string, string> = {
  "false-urgency": "false urgency",
  "phantom-buyer": "invented rival buyer",
  "hidden-fee": "hidden fee",
  "teaser-price": "teaser price",
  overpromise: "overpromise",
  upsell: "upsell",
};

/**
 * A seller's answer. `offer` is a firm cash offer, or null for a quote request
 * (the agent asks for their best price without committing to one).
 * Sellers never counter below a firm offer and never go below their floor.
 */
export function reply(s: Seller, offer: number | null, ctx: ReplyContext): Reply {
  const { rng, text, item, round } = ctx;
  const a = s.archetype.id;
  const beats: Beat[] = [];
  const closeEnough = Math.max(1, Math.round(item.price.typical * 0.03));
  // A final offer at or above the floor is usually taken; stubborn sellers sometimes hold out.
  const takesFinal = offer !== null && ctx.finalOffer && offer >= s.floor && rng.chance(s.archetype.concession === "slow" ? 0.65 : 0.9);

  const accept = (price: number): Reply => {
    s.ask = price;
    s.agreedAt = price;
    beats.push({ kind: "seller", round, sellerId: s.id, move: "accept", price, text: text.seller(a, "accept", { price }) });
    return { beats, acceptedAt: price, matched: false };
  };

  if (offer !== null && (offer >= s.ask || (offer >= s.floor && (s.ask - offer <= closeEnough || takesFinal)))) return accept(Math.min(offer, s.ask));

  const pressure = offer ?? ctx.anchorHint ?? null;
  if (pressure !== null && pressure < s.floor * 0.75 && !s.insulted) {
    s.insulted = true;
    s.mood -= 1;
  }

  // Concede a share of the typical price per round: slower when insulted,
  // faster as the rounds run out and the buyer might leave.
  const [cMin, cMax] = sellerData.concessionSpeed[s.archetype.concession];
  const urgency = 1 + (round - 1) * 0.25;
  const step = Math.max(1, item.price.typical * rng.range(cMin, cMax) * s.concessionBoost * urgency * (s.mood < 0 ? 0.5 : 1));
  let next = Math.max(s.floor, Math.round(s.ask - step));

  // Competition: match or undercut the best all-in quote, compared like for like.
  let matched = false;
  if (ctx.leverageRef !== null) {
    const refCash = ctx.leverageRef - payNowFee(s);
    if (refCash < next) {
      const base = { fast: 0.85, medium: 0.6, slow: 0.3 }[s.archetype.concession];
      const boost = s.archetype.softSpots.includes("competitor-offer") ? 1.25 : 1;
      if (rng.chance(base * boost)) {
        const m = Math.max(s.floor, refCash - (s.archetype.concession === "fast" ? 2 : 1));
        if (m < next) {
          next = m;
          matched = true;
        }
      }
    }
  }

  // Never counter at or below the buyer's own offer: that is simply a yes.
  if (offer !== null && next <= offer) return accept(offer);

  s.ask = next;
  s.final = s.ask <= s.floor;
  const rebut = ctx.doubted && text.chance(0.6) ? text.talk("rebut") : "";
  const pitch = !rebut && round > 1 && text.chance(0.3) ? text.talk("pitch") : "";
  const opener = round === 1 ? (text.chance(0.5) ? text.talk("small") : text.talk("pitch")) : "";
  beats.push({
    kind: "seller",
    round,
    sellerId: s.id,
    move: s.final ? "final" : "counter",
    price: s.ask,
    text: join(opener, rebut, text.seller(a, s.final ? "final" : "counter", { price: s.ask }), pitch),
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
        text: text.tactic(a, tactic, { upsell: s.upsellPrice ?? undefined }),
      });
      if (sellerData.detectable.includes(tactic)) {
        beats.push({ kind: "detect", round, sellerId: s.id, tactic, text: `Detected: ${DETECT_LABEL[tactic] ?? tactic}` });
      }
    }
  }
  return { beats, acceptedAt: null, matched };
}
