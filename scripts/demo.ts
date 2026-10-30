// Prints a deal or a whole mission as a readable transcript.
// Usage:
//   node scripts/demo.ts deal usb-mic [seed] [--rogue]
//   node scripts/demo.ts mission hackathon-10-days [seed]
import { getItem, runDeal, runMission } from "../src/engine/index.ts";
import type { DealResult } from "../src/engine/index.ts";

const [mode = "mission", id = "hackathon-10-days", seedArg] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const rogue = process.argv.includes("--rogue");
const seed = seedArg ? Number(seedArg) : 42;

function printDeal(d: DealResult) {
  const item = getItem(d.itemId);
  const name = (sid: string) => d.sellers.find((s) => s.id === sid)?.name ?? sid;
  console.log(`\n=== ${item.name} (seed ${d.seed}) ===`);
  console.log(`Price card: low $${item.price.low} · typical $${item.price.typical} · high $${item.price.high}`);
  console.log(`Agent plan: anchor $${d.plan.anchor} · target $${d.plan.target} · walk-away $${d.plan.walkAway} · offers ${d.plan.offers.map((o) => "$" + o).join(" → ")}`);
  console.log(`Sellers: ${d.sellers.map((s) => `${s.name} (${s.archetype}, opens $${s.openAsk})`).join(" | ")}\n`);
  for (const b of d.beats) {
    const r = `R${b.round}`.padEnd(4);
    if (b.kind === "agent") console.log(`${r}AGENT → ${b.to.map(name).join(", ")}: ${b.text}`);
    else if (b.kind === "seller") console.log(`${r}${name(b.sellerId)}: ${b.text}`);
    else if (b.kind === "detect") console.log(`${r}  ⚠ ${b.text} (${name(b.sellerId)})`);
    else if (b.kind === "event") console.log(`${r}⚡ ${b.text}`);
    else console.log(`${r}  🎙 ${b.text}`);
  }
  const o = d.outcome;
  console.log(
    o.status === "deal"
      ? `\nRESULT: ${o.sellerName} at $${o.price}${o.fee ? ` + $${o.fee} fee now` : ""}${o.levers.length ? ` with ${o.levers.map((l) => l.label.toLowerCase()).join(", ")}` : ""}${o.futureFee ? ` (+ $${o.futureFee} later)` : ""} · pays $${o.amountToPay} · ${o.savedVsTypical}% vs typical${o.rogue ? " · ROGUE" : ""}`
      : `\nRESULT: walked away`,
  );
  if (o.afterPayment) console.log(`AFTER PAYMENT: ${o.afterPayment.text}`);
  console.log(`Hidden floors (revealed after the game): ${d.sellers.map((s) => `${s.name} $${s.floor}`).join(" · ")}`);
}

if (mode === "deal") {
  printDeal(runDeal(id, { seed, rogue, itemCapUsd: rogue ? 70 : undefined }));
} else {
  const m = runMission(id, { seed });
  m.lines.forEach((l) => {
    printDeal(l.deal);
    if (l.guard) console.log(`AgentGuard: ${l.guard.summary}`);
  });
  console.log(`\n=== Mission: spent $${m.spentUsd}, waiting for your OK $${m.pendingUsd}, budget $${m.budgetUsd} ===`);
  m.lines.forEach((l) => console.log(`- ${l.itemName}: ${l.status}${l.deal.outcome.price ? ` ($${l.deal.outcome.amountToPay})` : ""}`));
}
