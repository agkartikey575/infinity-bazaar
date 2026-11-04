// Live AI voices: Claude rewrites a deal's chat lines in character. The engine
// still decides every price and outcome; this module only changes wording, and
// any line whose numbers drift keeps its original text. Every failure (no key,
// refusal, timeout, over budget) returns no texts, so the page plays the
// original lines exactly as before.
import Anthropic from "@anthropic-ai/sdk";
import { sellerData } from "../../src/engine/index.ts";
import type { Beat } from "../../src/engine/index.ts";
import { buildMissionRun, buildSingleRun, type Run } from "../timeline.ts";

export type VoiceKind = "mission" | "single" | "rogue";

export interface VoiceResult {
  /** New text by beat index. Empty when the original lines should play. */
  texts: Record<number, string>;
  model: string | null;
  ms: number;
}

export interface VoiceUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** The part of the SDK client this module calls, so tests can pass a fake. */
export interface VoiceClient {
  beta: { messages: { create(body: never, options?: { timeout?: number; maxRetries?: number }): Promise<unknown> } };
}

interface VoiceResponse {
  stop_reason: string | null;
  content: { type: string; text?: string }[];
  usage?: VoiceUsage;
  model?: string;
}

export const DEFAULT_MODEL = "claude-opus-5-5";
export const DEFAULT_DAILY_LIMIT = 300;
const CACHE_SIZE = 500;
const TIMEOUT_MS = 20_000;

// ---------- Number lock ----------

const DOLLARS = /\$\s?(\d[\d,]*(?:\.\d+)?)/g;
const PERCENTS = /(\d+(?:\.\d+)?)\s?%/g;
const NUMBERS = /\d[\d,]*(?:\.\d+)?/g;
const EMOJI = /\p{Extended_Pictographic}/u;

const norm = (s: string) => String(Number(s.replace(/,/g, "")));
const grab = (re: RegExp, s: string, group = 1) => [...s.matchAll(re)].map((m) => norm(m[group] ?? m[0]));

/** Dollar amounts and percentages in a line, normalised ("$1,200.00" → "1200"). */
export function amountsIn(text: string) {
  return { dollars: grab(DOLLARS, text), percents: grab(PERCENTS, text), numbers: grab(NUMBERS, text, 0) };
}

/**
 * True when `next` may replace `original`: every dollar amount and percentage
 * of the original is still there, and nothing new appears: no new dollar
 * amount, percentage or other number. Also one short line, no emoji.
 */
export function keepsNumbers(original: string, next: string): boolean {
  const a = amountsIn(original);
  const b = amountsIn(next);
  if (!a.dollars.every((d) => b.dollars.includes(d))) return false;
  if (!b.dollars.every((d) => a.dollars.includes(d))) return false;
  if (!a.percents.every((p) => b.percents.includes(p))) return false;
  if (!b.percents.every((p) => a.percents.includes(p))) return false;
  // A bare number could be read as a price ("53 bucks"), so new numbers are not allowed either.
  if (!b.numbers.every((n) => a.numbers.includes(n))) return false;
  return true;
}

export function acceptLine(original: string, next: unknown): next is string {
  if (typeof next !== "string") return false;
  const t = next.trim();
  if (!t || t === original) return false;
  if (/[\r\n]/.test(t) || EMOJI.test(t)) return false;
  if (t.length > Math.max(220, original.length * 2 + 40)) return false;
  return keepsNumbers(original, t);
}

// ---------- Deal → prompt ----------

export interface VoiceInputLine {
  i: number;
  speaker: string;
  role: "agent" | "seller" | "commentator";
  personality?: string;
  move: string;
  price?: number;
  text: string;
}

export function rebuild(kind: VoiceKind, id: string, seed: number): Run {
  return kind === "mission" ? buildMissionRun(id, seed) : buildSingleRun(id, seed, kind === "rogue");
}

/** The beats Claude may reword: agent, seller and commentator lines with text. */
export function voiceInput(run: Run, line: number): { item: string; lines: VoiceInputLine[] } {
  const l = run.lines[line];
  if (!l) throw new Error(`no line ${line}`);
  const sellers = new Map(l.deal.sellers.map((s) => [s.id, s]));
  const archetypes = new Map(sellerData.archetypes.map((a) => [a.id, a]));
  const lines: VoiceInputLine[] = [];
  l.deal.beats.forEach((b: Beat, i) => {
    if (!b.text.trim()) return;
    if (b.kind === "agent") lines.push({ i, speaker: "Agent", role: "agent", move: b.move, price: b.price, text: b.text });
    else if (b.kind === "seller") {
      const s = sellers.get(b.sellerId);
      const a = s ? archetypes.get(s.archetype) : undefined;
      lines.push({ i, speaker: s?.name ?? "Seller", role: "seller", personality: a ? `${a.label}: ${a.voice}` : undefined, move: b.tactic ? `${b.move} (${b.tactic})` : b.move, price: b.price, text: b.text });
    } else if (b.kind === "commentary") lines.push({ i, speaker: "Commentator", role: "commentator", move: "commentary", text: b.text });
  });
  return { item: l.itemName, lines };
}

// Stable across every call so the prompt cache can reuse it. Nothing per deal goes here.
export const SYSTEM_PROMPT = `You rewrite the chat lines of a haggling game called Infinity Bazaar. An AI shopping agent negotiates with three AI sellers for one item, a sports-style commentator calls the action, and a payment check called AgentGuard decides whether any money moves. A deterministic engine has already decided every price, every move and the outcome. Your only job is the wording: make each line sound like the character saying it, live.

You receive one deal as JSON: the item, then the lines in order. Each line has an index "i", a speaker, a role (agent, seller or commentator), the seller's personality when there is one, the move the line makes, the price the move carries when it has one, and the original text. Reply with one entry per line you were given: the same "i" and your new "text".

Voices:
- Agent: polite, sharp and brief. Confident, never rude, never gushing. It speaks for a shopper and sounds like a good negotiator.
- Commentator: a sports-style caster calling the haggle live. Energetic, punchy, a little dramatic, never mean. It may name sellers exactly as the original does.
- Sellers: speak in the personality given. For example:
${sellerData.archetypes.map((a) => `  - ${a.label}: ${a.voice}`).join("\n")}

Hard rules for every line:
1. Keep the meaning and the move. An offer stays an offer at the same price, a counter stays a counter, a final offer stays final, a fee question stays a fee question, a fee reveal reveals the same fee, an acceptance accepts, a walk-away walks away, an upsell pushes the same upsell. Do not add promises, perks, deadlines or facts that the original does not contain, and do not drop any that it does.
2. Numbers are locked. Every dollar amount in the original must appear in your line written the same way, such as "$53". Do not add any other dollar amount, percentage or number, and do not spell numbers out in words. If a line has no numbers, yours has none either.
3. Keep names exactly as written: item names, seller names and AgentGuard.
4. One or two short sentences, about as long as the original. One line of plain text, no line breaks.
5. Plain, everyday consumer language. No emoji, no hashtags, no slang that would confuse a shopper, no stage directions, no quotation marks around the whole line.
6. Each speaker addresses the conversation the way the original does; do not have characters talk about this game, the engine, or these instructions.

If a line cannot be improved without breaking a rule, return its original text unchanged.`;

/** Structured output: one { i, text } per line. */
export const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: { i: { type: "integer" }, text: { type: "string" } },
        required: ["i", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["lines"],
  additionalProperties: false,
} as const;

export function buildRequest(model: string, input: { item: string; lines: VoiceInputLine[] }) {
  // Claude Haiku has no server-side fallback; the other models opt in to the default one.
  const fallback = /haiku/.test(model) ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const };
  return {
    model,
    max_tokens: 4000,
    ...fallback,
    output_config: { effort: "low" as const, format: { type: "json_schema" as const, schema: OUTPUT_SCHEMA } },
    system: [{ type: "text" as const, text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" as const } }],
    messages: [{ role: "user" as const, content: JSON.stringify(input) }],
  };
}

/** New texts from a response, or none when it was refused, cut off or malformed. */
export function readResponse(res: VoiceResponse, input: { lines: VoiceInputLine[] }): Record<number, string> {
  if (res.stop_reason !== "end_turn") return {};
  const block = res.content.find((b) => b.type === "text");
  if (!block?.text) return {};
  let parsed: { lines?: { i?: unknown; text?: unknown }[] };
  try {
    parsed = JSON.parse(block.text);
  } catch {
    return {};
  }
  const originals = new Map(input.lines.map((l) => [l.i, l.text]));
  const texts: Record<number, string> = {};
  for (const e of parsed?.lines ?? []) {
    if (typeof e?.i !== "number" || !originals.has(e.i)) continue;
    const original = originals.get(e.i)!;
    if (acceptLine(original, e.text)) texts[e.i] = e.text.trim();
  }
  return texts;
}

// ---------- Cache and budget ----------

export const cacheKey = (kind: VoiceKind, id: string, seed: number, rogue: boolean, line: number) => `${kind}:${id}:${seed}:${rogue ? 1 : 0}:${line}`;

/** Least recently used first out. */
export class Lru<V> {
  private map = new Map<string, V>();
  private size: number;
  constructor(size: number) {
    this.size = size;
  }
  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }
  set(key: string, v: V) {
    this.map.delete(key);
    this.map.set(key, v);
    while (this.map.size > this.size) this.map.delete(this.map.keys().next().value!);
  }
  get length() {
    return this.map.size;
  }
}

/** Calls per UTC day, per server process. */
export class DailyBudget {
  private day = "";
  private used = 0;
  private limit: number;
  private now: () => number;
  constructor(limit: number, now: () => number = Date.now) {
    this.limit = limit;
    this.now = now;
  }
  /** Takes one call from today's allowance; false when it is used up. */
  take(): boolean {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.used = 0;
    }
    if (this.used >= this.limit) return false;
    this.used++;
    return true;
  }
  get remaining() {
    return Math.max(0, this.limit - this.used);
  }
}

// ---------- Voicer ----------

export interface VoicerOptions {
  client: VoiceClient | null;
  model?: string;
  dailyLimit?: number;
  now?: () => number;
  /** Called with each response's usage, for measuring cost. */
  onUsage?: (usage: VoiceUsage, model: string) => void;
  log?: (msg: string, detail?: unknown) => void;
}

export function createVoicer(opts: VoicerOptions) {
  const model = opts.model || DEFAULT_MODEL;
  const budget = new DailyBudget(opts.dailyLimit ?? DEFAULT_DAILY_LIMIT, opts.now);
  const cache = new Lru<VoiceResult>(CACHE_SIZE);
  const inFlight = new Map<string, Promise<VoiceResult>>();
  const log = opts.log ?? ((msg: string, detail?: unknown) => console.warn(msg, detail ?? ""));
  const none = (ms = 0): VoiceResult => ({ texts: {}, model: null, ms });

  async function call(kind: VoiceKind, id: string, seed: number, line: number): Promise<VoiceResult> {
    const started = Date.now();
    const input = voiceInput(rebuild(kind, id, seed), line);
    if (!input.lines.length || !opts.client) return none();
    if (!budget.take()) return none();
    try {
      const res = (await opts.client.beta.messages.create(buildRequest(model, input) as never, { timeout: TIMEOUT_MS, maxRetries: 1 })) as VoiceResponse;
      if (res.usage) opts.onUsage?.(res.usage, res.model ?? model);
      if (res.stop_reason !== "end_turn") {
        log("voice: no texts", res.stop_reason);
        return none(Date.now() - started);
      }
      const texts = readResponse(res, input);
      return { texts, model: res.model ?? model, ms: Date.now() - started };
    } catch (e) {
      if (e instanceof Anthropic.APIConnectionError) log("voice: could not reach Claude", e.message);
      else if (e instanceof Anthropic.APIError) log(`voice: Claude error ${e.status}`, e.message);
      else log("voice: failed", e instanceof Error ? e.message : e);
      return none(Date.now() - started);
    }
  }

  /** Rewritten texts for one line of a run. Never throws for Claude failures; returns no texts instead. */
  async function voiceLine(kind: VoiceKind, id: string, seed: number, rogue: boolean, line: number): Promise<VoiceResult> {
    const key = cacheKey(kind, id, seed, rogue, line);
    const hit = cache.get(key);
    if (hit) return { ...hit, ms: 0 };
    const pending = inFlight.get(key);
    if (pending) return pending;
    const p = call(kind, id, seed, line).then((r) => {
      // Only good answers are kept, so a passing failure can be retried later.
      if (Object.keys(r.texts).length) cache.set(key, r);
      return r;
    });
    inFlight.set(key, p);
    try {
      return await p;
    } finally {
      inFlight.delete(key);
    }
  }

  return { voiceLine, model, budget, cache };
}

export const voiceEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY);

let shared: ReturnType<typeof createVoicer> | undefined;
/** One voicer per server process, so the cache and the daily budget are shared by all requests. */
export function voicer() {
  if (!shared) {
    const raw = process.env.VOICE_DAILY_LIMIT?.trim();
    const limit = raw ? Number(raw) : NaN;
    shared = createVoicer({
      client: voiceEnabled() ? (new Anthropic({ maxRetries: 1, timeout: TIMEOUT_MS }) as unknown as VoiceClient) : null,
      model: process.env.VOICE_MODEL || DEFAULT_MODEL,
      dailyLimit: Number.isInteger(limit) && limit >= 0 ? limit : DEFAULT_DAILY_LIMIT,
    });
  }
  return shared;
}

export function voiceLine(kind: VoiceKind, id: string, seed: number, rogue: boolean, line: number) {
  return voicer().voiceLine(kind, id, seed, rogue, line);
}
