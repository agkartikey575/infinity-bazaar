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
  beta: { messages: { create(body: never, options?: { timeout?: number; maxRetries?: number; signal?: AbortSignal }): Promise<unknown> } };
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
//
// A rewritten line may change words, never numbers. It passes only when:
// - its dollar amounts, in order, are exactly the original's, written the same way ("$12.50" stays "$12.50");
// - its percentages, in order, are exactly the original's;
// - every other number in it also appears in the original;
// - no amount gains a size or time unit the original didn't give it ("$53k", "$53 per month");
// - it spells out no number the original didn't ("fifty", "half", "double", "percent");
// - every digit is a plain 0-9 and every comma sits in a real thousands group.

/** A number as written: plain, decimal, or with valid thousands commas. */
const NUM = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;
const DOLLARS = new RegExp(String.raw`\$\s?(${NUM})`, "g");
const PERCENTS = new RegExp(String.raw`(${NUM})\s?%`, "g");
const NUMBERS = new RegExp(NUM, "g");
/** Any run of digits and commas, to catch commas that don't form thousands groups ("$5,3"). */
const DIGIT_RUNS = /\d[\d,]*\d|\d/g;
const VALID_RUN = /^(?:\d+|\d{1,3}(?:,\d{3})+)$/;
const NON_ASCII_DIGIT = /(?![0-9])\p{Nd}/u;
/** Size or time units that change what an amount means. */
const SUFFIX = /^\s*(k|m|mm|b|bn|mil|thousand|million|billion|grand|\/\s*(?:mo|month|yr|year|wk|week|day|hr|hour)|per\s+(?:mo|month|yr|year|wk|week|day|hr|hour)|a\s+(?:month|year|week|day)|monthly|yearly|annually|weekly|daily)\b/i;
const NUMBER_WORDS = new RegExp(
  String.raw`\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|dozen|half|quarter|double|twice|triple|percent|per\s+cent)\b`,
  "gi",
);
const EMOJI = /\p{Extended_Pictographic}/u;

const all = (re: RegExp, s: string, group = 0) => [...s.matchAll(re)].map((m) => m[group]);
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Each number with the unit written right after it, such as "53 k" or "14 /mo". */
function unitsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(NUMBERS)) {
    const u = text.slice(m.index! + m[0].length).match(SUFFIX);
    if (u) out.push(`${m[0]} ${u[1].toLowerCase().replace(/\s+/g, " ")}`);
  }
  return out;
}

/** Dollar amounts and percentages in order, exactly as written, and every number. */
export function amountsIn(text: string) {
  return { dollars: all(DOLLARS, text, 1), percents: all(PERCENTS, text, 1), numbers: all(NUMBERS, text) };
}

/** True when `next` says exactly the same numbers as `original`. See the rules above. */
export function keepsNumbers(original: string, next: string): boolean {
  if (NON_ASCII_DIGIT.test(next)) return false;
  if (!all(DIGIT_RUNS, next).every((r) => VALID_RUN.test(r))) return false;
  const a = amountsIn(original);
  const b = amountsIn(next);
  if (!sameList(a.dollars, b.dollars)) return false;
  if (!sameList(a.percents, b.percents)) return false;
  // A bare number could be read as a price ("53 bucks"), so new numbers are not allowed either.
  if (!b.numbers.every((n) => a.numbers.includes(n))) return false;
  const units = unitsIn(original);
  if (!unitsIn(next).every((u) => units.includes(u))) return false;
  const words = new Set(all(NUMBER_WORDS, original).map((w) => w.toLowerCase().replace(/\s+/g, " ")));
  if (!all(NUMBER_WORDS, next).every((w) => words.has(w.toLowerCase().replace(/\s+/g, " ")))) return false;
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
2. Numbers are locked. Every dollar amount in the original must appear in your line written the same way, such as "$53". Keep them in the same order. Do not add any other dollar amount, percentage or number, do not add units such as "k" or "per month" after an amount, and do not write numbers as words: avoid words like one, two, ten, fifty, hundred, half, double, twice or percent unless the original uses that word. If a line has no numbers, yours has none either.
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
    max_tokens: 8000,
    ...fallback,
    output_config: { effort: "low" as const, format: { type: "json_schema" as const, schema: OUTPUT_SCHEMA } },
    system: [{ type: "text" as const, text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" as const } }],
    messages: [{ role: "user" as const, content: JSON.stringify(input) }],
  };
}

/** New texts from a response, or none when it was refused, cut off or malformed. */
export function readResponse(res: VoiceResponse, input: { lines: VoiceInputLine[] }): Record<number, string> {
  if (res.stop_reason !== "end_turn") return {};
  // After a server-side fallback, the answer is the text after the last switch point.
  const lastSwitch = res.content.map((b) => b.type).lastIndexOf("fallback");
  const block = res.content.slice(lastSwitch + 1).find((b) => b.type === "text");
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

/** Claude requests per UTC day, per server instance. Every attempt counts, retries included. */
export class DailyBudget {
  private day = "";
  private used = 0;
  private limit: number;
  private now: () => number;
  constructor(limit: number, now: () => number = Date.now) {
    this.limit = limit;
    this.now = now;
  }
  private roll() {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.used = 0;
    }
  }
  /** Takes one request from today's allowance; false when it is used up. */
  take(): boolean {
    this.roll();
    if (this.used >= this.limit) return false;
    this.used++;
    return true;
  }
  get remaining() {
    this.roll();
    return Math.max(0, this.limit - this.used);
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CLIENTS = 5000;

/** New Claude calls per client over the last 24 hours (a sliding window), per server instance. */
export class ClientLimit {
  private hits = new Map<string, number[]>();
  private limit: number;
  private now: () => number;
  constructor(limit: number, now: () => number = Date.now) {
    this.limit = limit;
    this.now = now;
  }
  take(client: string): boolean {
    const now = this.now();
    const recent = (this.hits.get(client) ?? []).filter((t) => now - t < DAY_MS);
    if (recent.length >= this.limit) {
      this.hits.set(client, recent);
      return false;
    }
    recent.push(now);
    this.hits.delete(client);
    this.hits.set(client, recent);
    // Bounded memory: forget the least recently seen clients first.
    while (this.hits.size > MAX_CLIENTS) this.hits.delete(this.hits.keys().next().value!);
    return true;
  }
}

// ---------- Voicer ----------

export const DEFAULT_PER_CLIENT_LIMIT = 30;

export interface VoicerOptions {
  client: VoiceClient | null;
  model?: string;
  dailyLimit?: number;
  perClientLimit?: number;
  now?: () => number;
  /** Wait before the one retry, in milliseconds. */
  retryDelayMs?: number;
  /** Called with each response's usage, for measuring cost. */
  onUsage?: (usage: VoiceUsage, model: string) => void;
  log?: (msg: string, detail?: unknown) => void;
}

export interface VoiceContext {
  /** Who is asking, for the per-client limit (the caller's IP address). */
  client?: string;
  /** Aborts when the caller goes away, such as when the table changes. */
  signal?: AbortSignal;
}

/** Overloaded, rate limited, a server error or no connection: worth one more try. */
function retryable(e: unknown) {
  if (e instanceof Anthropic.APIUserAbortError) return false;
  if (e instanceof Anthropic.APIConnectionError) return true;
  return e instanceof Anthropic.APIError && typeof e.status === "number" && (e.status === 429 || e.status >= 500);
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted || ms <= 0) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

interface Flight {
  p: Promise<VoiceResult>;
  ctrl: AbortController;
  waiters: number;
}

export function createVoicer(opts: VoicerOptions) {
  const model = opts.model || DEFAULT_MODEL;
  const budget = new DailyBudget(opts.dailyLimit ?? DEFAULT_DAILY_LIMIT, opts.now);
  const perClient = new ClientLimit(opts.perClientLimit ?? DEFAULT_PER_CLIENT_LIMIT, opts.now);
  const cache = new Lru<VoiceResult>(CACHE_SIZE);
  const inFlight = new Map<string, Flight>();
  const log = opts.log ?? ((msg: string, detail?: unknown) => console.warn(msg, detail ?? ""));
  const none = (ms = 0): VoiceResult => ({ texts: {}, model: null, ms });

  async function call(kind: VoiceKind, id: string, seed: number, line: number, signal: AbortSignal): Promise<VoiceResult> {
    const started = Date.now();
    const input = voiceInput(rebuild(kind, id, seed), line);
    if (!input.lines.length || !opts.client) return none();
    const body = buildRequest(model, input) as never;
    // One try plus at most one retry, each counted against the daily budget. The SDK's own retries are off.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal.aborted || !budget.take()) break;
      try {
        const res = (await opts.client.beta.messages.create(body, { timeout: TIMEOUT_MS, maxRetries: 0, signal })) as VoiceResponse;
        if (res.usage) opts.onUsage?.(res.usage, res.model ?? model);
        if (res.stop_reason !== "end_turn") {
          log("voice: no texts", res.stop_reason);
          break;
        }
        return { texts: readResponse(res, input), model: res.model ?? model, ms: Date.now() - started };
      } catch (e) {
        if (signal.aborted || e instanceof Anthropic.APIUserAbortError) break;
        if (e instanceof Anthropic.APIConnectionError) log("voice: could not reach Claude", e.message);
        else if (e instanceof Anthropic.APIError) log(`voice: Claude error ${e.status}`, e.message);
        else log("voice: failed", e instanceof Error ? e.message : e);
        if (!retryable(e)) break;
        await wait(opts.retryDelayMs ?? 500, signal);
      }
    }
    return none(Date.now() - started);
  }

  /** Waits for a shared call. Leaving early aborts the call only when every waiter has left. */
  function join(f: Flight, signal?: AbortSignal): Promise<VoiceResult> {
    f.waiters++;
    if (!signal) return f.p;
    return new Promise((resolve) => {
      let done = false;
      const leave = () => {
        if (done) return;
        done = true;
        if (--f.waiters === 0) f.ctrl.abort();
        resolve(none());
      };
      if (signal.aborted) return leave();
      signal.addEventListener("abort", leave, { once: true });
      f.p.then((r) => {
        if (done) return;
        done = true;
        signal.removeEventListener("abort", leave);
        resolve(r);
      });
    });
  }

  /** Rewritten texts for one line of a run. Never throws for Claude failures; returns no texts instead. */
  async function voiceLine(kind: VoiceKind, id: string, seed: number, rogue: boolean, line: number, ctx: VoiceContext = {}): Promise<VoiceResult> {
    const key = cacheKey(kind, id, seed, rogue, line);
    const hit = cache.get(key);
    if (hit) return { ...hit, ms: 0 };
    let f = inFlight.get(key);
    if (!f) {
      // Over a limit: answer at once, and the original lines play.
      if (!opts.client || ctx.signal?.aborted || budget.remaining === 0) return none();
      if (!perClient.take(ctx.client ?? "unknown")) return none();
      const ctrl = new AbortController();
      const flight: Flight = { ctrl, waiters: 0, p: Promise.resolve(none()) };
      flight.p = call(kind, id, seed, line, ctrl.signal)
        .then((r) => {
          // Only good answers are kept, so a passing failure can be retried later.
          if (Object.keys(r.texts).length) cache.set(key, r);
          return r;
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, flight);
      f = flight;
    }
    return join(f, ctx.signal);
  }

  return { voiceLine, model, budget, cache };
}

export const voiceEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY);

const envCount = (name: string, fallback: number) => {
  const raw = process.env[name]?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= 0 ? n : fallback;
};

let shared: ReturnType<typeof createVoicer> | undefined;
/**
 * One voicer per server instance, shared by all its requests. On serverless
 * hosting each instance keeps its own cache and its own counters.
 */
export function voicer() {
  if (!shared) {
    shared = createVoicer({
      client: voiceEnabled() ? (new Anthropic({ maxRetries: 0, timeout: TIMEOUT_MS }) as unknown as VoiceClient) : null,
      model: process.env.VOICE_MODEL || DEFAULT_MODEL,
      dailyLimit: envCount("VOICE_DAILY_LIMIT", DEFAULT_DAILY_LIMIT),
      perClientLimit: envCount("VOICE_PER_IP_LIMIT", DEFAULT_PER_CLIENT_LIMIT),
    });
  }
  return shared;
}

export function voiceLine(kind: VoiceKind, id: string, seed: number, rogue: boolean, line: number, ctx?: VoiceContext) {
  return voicer().voiceLine(kind, id, seed, rogue, line, ctx);
}
