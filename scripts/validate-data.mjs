// Checks that the data files in /data are consistent with each other.
// Run: node scripts/validate-data.mjs
import { readFileSync } from "node:fs";

const load = (name) => JSON.parse(readFileSync(new URL(`../data/${name}`, import.meta.url)));
const catalog = load("catalog.json");
const sellers = load("sellers.json");
const events = load("events.json");
const missions = load("missions.json");

const errors = [];
const fail = (msg) => errors.push(msg);

const groupIds = new Set(catalog.groups.map((g) => g.id));
const archetypeIds = new Set(sellers.archetypes.map((a) => a.id));
const itemsById = new Map();

for (const item of catalog.items) {
  const where = `item ${item.id}`;
  if (itemsById.has(item.id)) fail(`${where}: duplicate id`);
  itemsById.set(item.id, item);

  if (!groupIds.has(item.group)) fail(`${where}: unknown group ${item.group}`);
  const { low, typical, high } = item.price;
  if (!(low > 0 && low <= typical && typical <= high)) fail(`${where}: prices must satisfy 0 < low <= typical <= high`);

  const [fMin, fMax] = item.seller.floorRange;
  if (!(fMin > 0 && fMin <= fMax)) fail(`${where}: bad floorRange`);
  if (fMax >= typical) fail(`${where}: floor max ${fMax} must be below typical ${typical}`);

  if (item.sellerTypes.length < 3) fail(`${where}: needs at least 3 seller types`);
  for (const s of item.sellerTypes) if (!archetypeIds.has(s)) fail(`${where}: unknown seller type ${s}`);
  if (item.levers.length === 0) fail(`${where}: needs at least one lever`);
}

for (const a of sellers.archetypes) {
  for (const t of a.tactics) if (!sellers.tactics[t]) fail(`archetype ${a.id}: unknown tactic ${t}`);
  if (!sellers.concessionSpeed[a.concession]) fail(`archetype ${a.id}: unknown concession ${a.concession}`);
}

for (const e of events.events) {
  for (const s of e.appliesTo ?? []) if (!archetypeIds.has(s)) fail(`event ${e.id}: unknown seller type ${s}`);
}

for (const m of missions.missions) {
  let coreCaps = 0;
  for (const s of m.suggested) {
    const item = itemsById.get(s.item);
    if (!item) { fail(`mission ${m.id}: unknown item ${s.item}`); continue; }
    if (!m.allowedGroups.includes(item.group)) fail(`mission ${m.id}: ${s.item} is outside allowedGroups`);
    if (s.itemCapUsd < item.seller.floorRange[0]) fail(`mission ${m.id}: cap for ${s.item} is below every possible seller floor`);
    if (s.priority === "core") coreCaps += s.itemCapUsd;
  }
  if (coreCaps > m.budgetUsd) fail(`mission ${m.id}: core item caps ${coreCaps} exceed budget ${m.budgetUsd}`);
}

const counts = Object.fromEntries(catalog.groups.map((g) => [g.id, catalog.items.filter((i) => i.group === g.id).length]));
console.log(`${catalog.items.length} items`, counts);
console.log(`${sellers.archetypes.length} seller types, ${events.events.length} events, ${missions.missions.length} missions`);

if (errors.length) {
  console.error(`\n${errors.length} problem(s):\n- ` + errors.join("\n- "));
  process.exit(1);
}
console.log("All data checks passed.");
