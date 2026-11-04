// Live AI voices: the number lock, cache keys, the daily budget and every
// fallback path. The Claude client is a fake; no test calls the real API.
import { test } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { buildMissionRun } from "../lib/timeline.ts";
import { acceptLine, amountsIn, buildRequest, cacheKey, ClientLimit, createVoicer, DailyBudget, keepsNumbers, Lru, readResponse, voiceInput, type VoiceClient } from "../lib/server/voice.ts";

test("number lock: keeps every dollar amount and adds none", () => {
  assert.equal(keepsNumbers("We can do $53! Super competitive, right?", "$53, and honestly that's a steal."), true);
  assert.equal(keepsNumbers("Fine, $148. Charge it.", "Alright, $148 it is. Go ahead."), true);
  assert.equal(keepsNumbers("I'll pay $40 if you include shipping.", "Make it $40 with shipping and we're set."), true);
  // Dropped, changed or added amounts fail.
  assert.equal(keepsNumbers("We can do $53!", "We can do a great price!"), false);
  assert.equal(keepsNumbers("We can do $53!", "We can do $52!"), false);
  assert.equal(keepsNumbers("We can do $53!", "Was $70, now $53!"), false);
  // Percentages and bare numbers count too.
  assert.equal(keepsNumbers("Final offer: $60.", "Final offer: $60, that's 10% off."), false);
  assert.equal(keepsNumbers("Save 10% today at $45.", "Today only: $45, a 10% saving."), true);
  assert.equal(keepsNumbers("Save 10% today at $45.", "Today only: $45."), false);
  assert.equal(keepsNumbers("Any fees on top?", "Any fees on top? Like 5 bucks?"), false);
  assert.equal(keepsNumbers("Any fees on top?", "Anything extra at checkout?"), true);
  // Amounts must be written exactly as in the original.
  assert.equal(keepsNumbers("That comes to $1,200.", "All in, $1,200."), true);
  assert.equal(keepsNumbers("That comes to $1,200.", "All in, $1200."), false);
  assert.equal(keepsNumbers("That is $12.50 extra.", "It adds $12.50."), true);
  assert.equal(keepsNumbers("That is $12.50 extra.", "It adds $12.5."), false);
  assert.deepEqual(amountsIn("Pay $1,200.00 or 15%."), { dollars: ["1,200.00"], percents: ["15"], numbers: ["1,200.00", "15"] });
});

test("number lock: order, units, words, digits and commas", () => {
  const o = "Counter at $53.";
  assert.equal(acceptLine(o, "My counter is $53, take it or leave it."), true);
  // Units that change the size or the period of the amount.
  for (const bad of ["Counter at $53k.", "Counter at $53K.", "Counter at $53 million.", "Counter at $53 per month.", "Counter at $53/mo.", "Counter at $53 / month.", "Counter at $53 bn.", "Counter at $53 grand.", "Counter at $53 a year."]) {
    assert.equal(acceptLine(o, bad), false, bad);
  }
  // A word that merely starts with a unit letter is fine.
  assert.equal(acceptLine(o, "Counter at $53, more or less final."), true);
  // A unit the original already had may stay.
  assert.equal(acceptLine("Renewal is $14/mo after the first year.", "After the first year, renewal runs $14/mo."), true);
  // Commas must be real thousands groups.
  assert.equal(acceptLine(o, "Counter at $5,3."), false);
  assert.equal(acceptLine("Total $1,200.", "All in: $1,2000."), false);
  // Spelled-out numbers and shares, unless the original says them.
  for (const bad of ["Counter at $53, that's fifty percent off.", "Counter at $53, half off.", "Counter at $53, double the value.", "Counter at $53, twice as good.", "Counter at $53, one day only.", "Counter at $53, a quarter less.", "Counter at $53, a dozen extras.", "Counter at $53, ten per cent off."]) {
    assert.equal(acceptLine(o, bad), false, bad);
  }
  assert.equal(acceptLine("This one is $53.", "For this one, $53."), true);
  // Non-ASCII digits.
  assert.equal(acceptLine(o, "Counter at $53, that's ５０% off."), false);
  assert.equal(acceptLine(o, "Counter at $٥٣."), false);
  // Order counts: swapping two amounts changes who said what.
  assert.equal(acceptLine("I offered $45, you said $60.", "I offered $60, you said $45."), false);
  assert.equal(acceptLine("I offered $45, you said $60.", "My offer was $45 and yours was $60."), true);
  assert.equal(acceptLine("Save 10% or 20% today.", "Today: 20% or 10% off."), false);
});

test("acceptLine rejects empty, multi-line, emoji and overlong text", () => {
  const o = "We can do $53!";
  assert.equal(acceptLine(o, "Deal at $53, friend."), true);
  assert.equal(acceptLine(o, ""), false);
  assert.equal(acceptLine(o, 53), false);
  assert.equal(acceptLine(o, o), false);
  assert.equal(acceptLine(o, "Deal at $53.\nReally."), false);
  assert.equal(acceptLine(o, "Deal at $53 🎉"), false);
  assert.equal(acceptLine(o, `$53 ${"very ".repeat(60)}good`), false);
});

const run = buildMissionRun("hackathon-10-days", 42);
const input = voiceInput(run, 0);

test("voiceInput takes agent, seller and commentator lines with their beat index", () => {
  assert.ok(input.lines.length > 5);
  const beats = run.lines[0].deal.beats;
  for (const l of input.lines) {
    assert.equal(beats[l.i].text, l.text);
    assert.ok(["agent", "seller", "commentary"].includes(beats[l.i].kind));
  }
  assert.ok(input.lines.some((l) => l.role === "seller" && l.personality));
  assert.ok(!input.lines.some((l) => beats[l.i].kind === "detect"));
});

test("request: structured output, low effort, cached system prompt, fallbacks except on Haiku", () => {
  const r = buildRequest("claude-opus-5-5", input);
  assert.equal(r.output_config.effort, "low");
  assert.equal(r.output_config.format.type, "json_schema");
  assert.equal(r.max_tokens, 8000);
  assert.deepEqual(r.system[0].cache_control, { type: "ephemeral" });
  assert.equal("thinking" in r, false);
  assert.deepEqual((r as { betas?: string[] }).betas, ["server-side-fallback-2026-07-01"]);
  assert.equal((r as { fallbacks?: string }).fallbacks, "default");
  const h = buildRequest("claude-haiku-5-5", input);
  assert.equal("fallbacks" in h, false);
  assert.equal("betas" in h, false);
  // The system prompt is the same for every deal, so the prompt cache can reuse it.
  assert.equal(buildRequest("claude-opus-5-5", voiceInput(buildMissionRun("hackathon-10-days", 7), 1)).system[0].text, r.system[0].text);
});

const answer = (lines: { i: number; text: string }[], stop = "end_turn") => ({
  stop_reason: stop,
  model: "claude-opus-5-5",
  content: [{ type: "thinking", thinking: "" }, { type: "text", text: JSON.stringify({ lines }) }],
  usage: { input_tokens: 100, output_tokens: 50 },
});

/** A rewrite that passes the number lock: same text with a prefix. */
const good = input.lines.map((l) => ({ i: l.i, text: `Look, ${l.text}` }));

test("readResponse keeps valid lines and drops ones that break the lock", () => {
  const first = input.lines.find((l) => /\$\d/.test(l.text))!;
  const lines = good.map((g) => (g.i === first.i ? { i: g.i, text: "A totally different price: $1." } : g));
  const texts = readResponse(answer([...lines, { i: 9999, text: "stray" }]), input);
  assert.equal(texts[first.i], undefined);
  assert.equal(texts[9999], undefined);
  assert.equal(Object.keys(texts).length, input.lines.length - 1);
  assert.deepEqual(readResponse(answer(good, "refusal"), input), {});
  assert.deepEqual(readResponse(answer(good, "max_tokens"), input), {});
  assert.deepEqual(readResponse({ stop_reason: "end_turn", content: [{ type: "text", text: "{not json" }] }, input), {});
});

function fakeClient(respond: () => unknown) {
  const calls: { body: unknown; options: unknown }[] = [];
  const client: VoiceClient = {
    beta: {
      messages: {
        create: async (body: never, options?: unknown) => {
          calls.push({ body, options });
          const r = respond();
          if (r instanceof Error) throw r;
          return r;
        },
      },
    },
  };
  return { client, calls };
}

test("cache: keyed by kind, id, seed, rogue and line; repeat calls are free", async () => {
  assert.equal(cacheKey("mission", "hackathon-10-days", 42, false, 0), "mission:hackathon-10-days:42:0:0");
  assert.notEqual(cacheKey("single", "usb-mic", 7, false, 0), cacheKey("rogue", "usb-mic", 7, true, 0));
  const { client, calls } = fakeClient(() => answer(good));
  const v = createVoicer({ client, log: () => {} });
  const a = await v.voiceLine("mission", "hackathon-10-days", 42, false, 0);
  assert.ok(Object.keys(a.texts).length > 0);
  assert.equal(a.model, "claude-opus-5-5");
  const b = await v.voiceLine("mission", "hackathon-10-days", 42, false, 0);
  assert.deepEqual(b.texts, a.texts);
  assert.equal(calls.length, 1);
  // Two requests at once share one call.
  await Promise.all([v.voiceLine("mission", "hackathon-10-days", 42, false, 1), v.voiceLine("mission", "hackathon-10-days", 42, false, 1)]);
  assert.equal(calls.length, 2);
  // Different seed or line: a new call.
  await v.voiceLine("mission", "hackathon-10-days", 43, false, 0);
  assert.equal(calls.length, 3);
  const opt = calls[0].options as { timeout: number; maxRetries: number; signal: AbortSignal };
  assert.equal(opt.timeout, 20_000);
  assert.equal(opt.maxRetries, 0);
  assert.ok(opt.signal instanceof AbortSignal);
});

test("LRU drops the least recently used entry", () => {
  const c = new Lru<number>(2);
  c.set("a", 1);
  c.set("b", 2);
  c.get("a");
  c.set("c", 3);
  assert.equal(c.get("b"), undefined);
  assert.equal(c.get("a"), 1);
  assert.equal(c.length, 2);
});

test("budget: daily cap, reset at the next UTC day", async () => {
  let now = Date.parse("2026-11-04T10:00:00Z");
  const b = new DailyBudget(2, () => now);
  assert.equal(b.take(), true);
  assert.equal(b.take(), true);
  assert.equal(b.take(), false);
  now = Date.parse("2026-11-05T00:00:01Z");
  assert.equal(b.take(), true);

  const { client, calls } = fakeClient(() => answer(good));
  const v = createVoicer({ client, dailyLimit: 1, now: () => now, log: () => {} });
  assert.ok(Object.keys((await v.voiceLine("mission", "hackathon-10-days", 42, false, 0)).texts).length);
  const over = await v.voiceLine("mission", "hackathon-10-days", 42, false, 1);
  assert.deepEqual(over.texts, {});
  assert.equal(calls.length, 1);
  // Cached lines still come back over the cap.
  assert.ok(Object.keys((await v.voiceLine("mission", "hackathon-10-days", 42, false, 0)).texts).length);
});

test("errors, refusals and no client all fall back to the original lines", async () => {
  const none = createVoicer({ client: null });
  assert.deepEqual((await none.voiceLine("mission", "hackathon-10-days", 42, false, 0)).texts, {});

  let reply: unknown = new Error("network down");
  const { client, calls } = fakeClient(() => reply);
  const v = createVoicer({ client, log: () => {} });
  assert.deepEqual((await v.voiceLine("rogue", "usb-mic", 7, true, 0)).texts, {});
  reply = answer(good, "refusal");
  assert.deepEqual((await v.voiceLine("rogue", "usb-mic", 7, true, 0)).texts, {});
  // Failures are not cached, so a later call can still succeed.
  reply = { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ lines: [] }) }] };
  assert.deepEqual((await v.voiceLine("rogue", "usb-mic", 7, true, 0)).texts, {});
  assert.equal(calls.length, 3);
});

test("after a server-side fallback, the text after the last switch point is read", () => {
  const refused = { type: "text", text: JSON.stringify({ lines: good.map((g) => ({ i: g.i, text: `Refused ${g.text}` })) }) };
  const res = {
    stop_reason: "end_turn",
    content: [refused, { type: "fallback" }, { type: "thinking" }, { type: "text", text: JSON.stringify({ lines: good }) }],
  };
  const texts = readResponse(res, input);
  assert.equal(texts[good[0].i], good[0].text);
});

test("per-client limit: a sliding 24-hour window per IP; cache hits are free", async () => {
  let now = Date.parse("2026-11-04T10:00:00Z");
  const l = new ClientLimit(2, () => now);
  assert.equal(l.take("1.2.3.4"), true);
  now += 60_000;
  assert.equal(l.take("1.2.3.4"), true);
  assert.equal(l.take("1.2.3.4"), false);
  assert.equal(l.take("5.6.7.8"), true);
  // The first call leaves the window 24 hours after it was made.
  now += 24 * 60 * 60 * 1000 - 30_000;
  assert.equal(l.take("1.2.3.4"), true);
  assert.equal(l.take("1.2.3.4"), false);

  const { client, calls } = fakeClient(() => answer(good));
  const v = createVoicer({ client, perClientLimit: 1, log: () => {} });
  const a = { client: "1.2.3.4" };
  assert.ok(Object.keys((await v.voiceLine("mission", "hackathon-10-days", 42, false, 0, a)).texts).length);
  assert.deepEqual((await v.voiceLine("mission", "hackathon-10-days", 42, false, 1, a)).texts, {});
  assert.ok(Object.keys((await v.voiceLine("mission", "hackathon-10-days", 42, false, 0, a)).texts).length, "cache hit over the limit");
  assert.ok(Object.keys((await v.voiceLine("mission", "hackathon-10-days", 42, false, 1, { client: "5.6.7.8" })).texts).length);
  assert.equal(calls.length, 2);
});

test("budget counts every attempt: one retry on connection errors, none on others", async () => {
  const { client, calls } = fakeClient(() => new Anthropic.APIConnectionError({ message: "down" }));
  const v = createVoicer({ client, dailyLimit: 3, retryDelayMs: 0, log: () => {} });
  assert.deepEqual((await v.voiceLine("mission", "hackathon-10-days", 42, false, 0)).texts, {});
  assert.equal(calls.length, 2);
  assert.equal(v.budget.remaining, 1);
  // Only one attempt is left, so there is no retry.
  await v.voiceLine("mission", "hackathon-10-days", 42, false, 1);
  assert.equal(calls.length, 3);
  assert.equal(v.budget.remaining, 0);
  // Over the cap: no call at all.
  await v.voiceLine("mission", "hackathon-10-days", 42, false, 2);
  assert.equal(calls.length, 3);

  const plain = fakeClient(() => new Error("bad"));
  const w = createVoicer({ client: plain.client, retryDelayMs: 0, log: () => {} });
  await w.voiceLine("mission", "hackathon-10-days", 42, false, 0);
  assert.equal(plain.calls.length, 1);
});

/** A client whose calls wait until released, or until their signal aborts. */
function slowClient() {
  const seen: AbortSignal[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const client: VoiceClient = {
    beta: {
      messages: {
        create: (_body: never, options?: { signal?: AbortSignal }) =>
          new Promise((resolve, reject) => {
            const signal = options!.signal!;
            seen.push(signal);
            signal.addEventListener("abort", () => reject(new Anthropic.APIUserAbortError()), { once: true });
            gate.then(() => resolve(answer(good)));
          }),
      },
    },
  };
  return { client, seen, release: () => release() };
}

test("abort: a shared call stops only when every waiter has gone", async () => {
  const c = slowClient();
  const v = createVoicer({ client: c.client, log: () => {} });
  const one = new AbortController();
  const two = new AbortController();
  const p1 = v.voiceLine("mission", "hackathon-10-days", 42, false, 0, { signal: one.signal });
  const p2 = v.voiceLine("mission", "hackathon-10-days", 42, false, 0, { signal: two.signal });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(c.seen.length, 1);
  one.abort();
  assert.deepEqual((await p1).texts, {});
  assert.equal(c.seen[0].aborted, false);
  two.abort();
  assert.deepEqual((await p2).texts, {});
  assert.equal(c.seen[0].aborted, true);

  // A waiter that stays gets the answer even though another left.
  const d = slowClient();
  const w = createVoicer({ client: d.client, log: () => {} });
  const gone = new AbortController();
  const q1 = w.voiceLine("mission", "hackathon-10-days", 42, false, 1, { signal: gone.signal });
  const q2 = w.voiceLine("mission", "hackathon-10-days", 42, false, 1, { signal: new AbortController().signal });
  gone.abort();
  d.release();
  assert.deepEqual((await q1).texts, {});
  assert.ok(Object.keys((await q2).texts).length);
  assert.equal(d.seen[0].aborted, false);

  // Already aborted: no call at all.
  const e = slowClient();
  const x = createVoicer({ client: e.client, log: () => {} });
  const done = new AbortController();
  done.abort();
  assert.deepEqual((await x.voiceLine("mission", "hackathon-10-days", 42, false, 0, { signal: done.signal })).texts, {});
  assert.equal(e.seen.length, 0);
});
