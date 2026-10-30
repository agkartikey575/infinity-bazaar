import catalogJson from "../../data/catalog.json" with { type: "json" };
import sellersJson from "../../data/sellers.json" with { type: "json" };
import eventsJson from "../../data/events.json" with { type: "json" };
import missionsJson from "../../data/missions.json" with { type: "json" };
import type { Archetype, Catalog, CatalogItem, GameEvent, Mission, SellerData } from "./types.ts";

export const catalog = catalogJson as unknown as Catalog;
export const sellerData = sellersJson as unknown as SellerData;
export const events = (eventsJson as unknown as { events: GameEvent[] }).events;
export const missions = (missionsJson as unknown as { missions: Mission[] }).missions;

export function getItem(id: string): CatalogItem {
  const item = catalog.items.find((i) => i.id === id);
  if (!item) throw new Error(`Unknown catalog item: ${id}`);
  return item;
}

export function getArchetype(id: string): Archetype {
  const a = sellerData.archetypes.find((x) => x.id === id);
  if (!a) throw new Error(`Unknown seller type: ${id}`);
  return a;
}

export function getMission(id: string): Mission {
  const m = missions.find((x) => x.id === id);
  if (!m) throw new Error(`Unknown mission: ${id}`);
  return m;
}
