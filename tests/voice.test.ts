// Live AI voices: the number lock, cache keys, the daily budget and every
// fallback path. The Claude client is a fake; no test calls the real API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMissionRun } from "../lib/timeline.ts";
import { acceptLine, amountsIn, buildRequest, cacheKey, createVoicer, DailyBudget, keepsNumbers, Lru, readResponse, voiceInput, type VoiceClient } from "../lib/server/voice.ts";

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
  // Formatting differences of the same amount are equal.
  assert.equal(keepsNumbers("That comes to $1,200.", "All in, $1200."), true);
  assert.equal(keepsNumbers("That is $12.50 extra.", "It adds $12.5."), true);
  assert.deepEqual(amountsIn("Pay $1,200.00 or 15%."), { dollars: ["1200"], percents: ["15"], numbers: ["1200", "15"] });
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
  assert.equal(r.max_tokens, 4000);
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
  assert.deepEqual(calls[0].options, { timeout: 20_000, maxRetries: 1 });
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
