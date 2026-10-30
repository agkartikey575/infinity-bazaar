// The buyer agent's price plan: anchor low, know the walk-away price,
// and rise in shrinking steps so sellers read "almost out of room".
import type { BuyerPlan, CatalogItem } from "./types.ts";

/** Share of the anchor-to-walk-away gap reached by each planned offer. */
const STEPS = [0, 0.45, 0.7, 0.85, 0.95, 1];

export function planBuyer(item: CatalogItem, itemCapUsd?: number): BuyerPlan {
  const { low, typical } = item.price;
  const [floorMin, floorMax] = item.seller.floorRange;

  // Walk away at the midpoint between the web low and the typical price, or the cap.
  const walkAway = Math.min(itemCapUsd ?? Infinity, Math.round((low + typical) / 2));
  // Open just under the cheapest listing found.
  const anchor = Math.min(Math.floor(low * 0.95), walkAway);
  // Aim for the middle of where sellers' floors usually sit.
  const target = Math.round(Math.min(walkAway, Math.max(anchor, (floorMin + floorMax) / 2)));

  const offers: number[] = [];
  for (const share of STEPS) {
    const price = Math.round(anchor + (walkAway - anchor) * share);
    if (offers.length === 0 || price > offers[offers.length - 1]) offers.push(price);
  }
  return { anchor, target, walkAway, offers };
}
