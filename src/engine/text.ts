// Wording for every move, drawn from data/dialogue.json and data/item-talk.json.
// Text uses its own random stream, so wording can change without changing any price.
import dialogueJson from "../../data/dialogue.json" with { type: "json" };
import itemTalkJson from "../../data/item-talk.json" with { type: "json" };
import { createRng, type Rng } from "./rng.ts";

type Lines = string[];
interface SellerLines {
  counter: Lines;
  final: Lines;
  accept: Lines;
  noFee: Lines;
  lieNoFee: Lines;
  revealFee: Lines;
  surpriseFee: Lines;
  grantLever: Lines;
  absorbFee: Lines;
  partialAbsorb: Lines;
  exit: Lines;
  lost: Lines;
  tactics: Record<string, Lines>;
}
interface ItemTalk {
  pitch: Lines;
  doubt: Lines;
  rebut: Lines;
  small: Lines;
  close: Lines;
}
interface Dialogue {
  agent: Record<string, Lines>;
  sellers: Record<string, SellerLines>;
  commentary: Record<string, Lines> & { detect: Record<string, Lines> };
}

export const dialogue = dialogueJson as unknown as Dialogue;
export const itemTalk = (itemTalkJson as unknown as { items: Record<string, ItemTalk> }).items;

export type Vars = Record<string, string | number | undefined>;

/** Replaces {name} placeholders. Unknown placeholders stay visible so tests catch them. */
export function fill(template: string, vars: Vars): string {
  const out = template.replace(/\{(\w+)\}/g, (m, key: string) => (vars[key] === undefined ? m : String(vars[key])));
  // A placeholder can open a sentence ("{lever}? Sure"): capitalise sentence starts.
  return out.replace(/(^|[.!?]\s+)([a-z])/g, (_, lead: string, ch: string) => lead + ch.toUpperCase());
}

/** Per-deal writer: picks fresh lines and avoids repeating one within the same deal. */
export class Writer {
  private rng: Rng;
  private used = new Set<string>();
  private itemId: string;

  constructor(seed: number, itemId: string) {
    this.rng = createRng((seed ^ 0x9e3779b9) >>> 0);
    this.itemId = itemId;
  }

  private pick(lines: Lines | undefined): string {
    if (!lines || lines.length === 0) return "";
    const fresh = lines.filter((l) => !this.used.has(l));
    const line = this.rng.pick(fresh.length ? fresh : lines);
    this.used.add(line);
    return line;
  }

  chance(p: number): boolean {
    return this.rng.chance(p);
  }

  agent(move: string, vars: Vars = {}): string {
    return fill(this.pick(dialogue.agent[move]), vars);
  }

  seller(archetype: string, move: Exclude<keyof SellerLines, "tactics">, vars: Vars = {}): string {
    return fill(this.pick(dialogue.sellers[archetype]?.[move]), vars);
  }

  tactic(archetype: string, tactic: string, vars: Vars = {}): string {
    return fill(this.pick(dialogue.sellers[archetype]?.tactics[tactic]), vars);
  }

  commentary(key: string, vars: Vars = {}): string {
    return fill(this.pick(dialogue.commentary[key] as Lines), vars);
  }

  detect(tactic: string, vars: Vars): string {
    return fill(this.pick(dialogue.commentary.detect[tactic]), vars);
  }

  /** An item-specific sentence, or "" once the pool for that kind is used up. */
  talk(kind: keyof ItemTalk): string {
    const lines = itemTalk[this.itemId]?.[kind] ?? [];
    const fresh = lines.filter((l) => !this.used.has(l));
    if (!fresh.length) return "";
    const line = this.rng.pick(fresh);
    this.used.add(line);
    return line;
  }
}

/** Joins a main line with optional extra sentences. */
export function join(...parts: (string | false | undefined | null)[]): string {
  return parts.filter(Boolean).join(" ");
}

/** Capitalises the first letter, for labels shown on their own. */
export const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
