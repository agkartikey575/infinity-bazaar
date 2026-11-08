import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { checkOrigin, clientIp, HttpError } from "../../../lib/server/request.ts";
import { rebuild, voiceEnabled, voiceLine, type VoiceKind } from "../../../lib/server/voice.ts";
import { readRules, rulesProblem, type PlayerRules } from "../../../lib/rules.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Room for one Claude call with a retry, so a slow answer ends cleanly instead of being cut off. */
export const maxDuration = 60;

const KINDS = new Set<VoiceKind>(["mission", "single", "rogue"]);
const ID = /^[a-z0-9-]{1,64}$/;

/** Whether live AI voices are available on this server. */
export function GET() {
  return NextResponse.json({ enabled: voiceEnabled() });
}

/**
 * Rewritten chat lines for one line of a run. The browser only names the run and
 * the line; the server rebuilds the deal itself, so nothing typed by a visitor
 * ever reaches the model.
 */
export async function POST(req: NextRequest) {
  try {
    checkOrigin(req);
    let body: { run?: { kind?: unknown; id?: unknown; seed?: unknown; rules?: unknown }; line?: unknown };
    try {
      body = await req.json();
    } catch {
      throw new HttpError(400, "The request body is not valid JSON.");
    }
    const run = body?.run;
    if (!run || !KINDS.has(run.kind as VoiceKind) || typeof run.id !== "string" || !ID.test(run.id) || !Number.isSafeInteger(run.seed) || (run.seed as number) < 1 || (run.seed as number) > 999_999_999) {
      throw new HttpError(400, "Invalid run.");
    }
    if (!Number.isInteger(body.line) || (body.line as number) < 0) throw new HttpError(400, "Invalid line.");
    // Your rules can change the deals, so the voices are written from the run with them.
    let rules: PlayerRules | undefined;
    if (run.rules !== undefined && run.rules !== null) {
      const problem = rulesProblem(run.rules);
      if (problem) throw new HttpError(400, `Invalid rules. ${problem}`);
      rules = readRules(run.rules)!;
    }
    if (!voiceEnabled()) return NextResponse.json({ enabled: false, texts: {} });

    const kind = run.kind as VoiceKind;
    const seed = run.seed as number;
    const line = body.line as number;
    let lines: number;
    try {
      lines = rebuild(kind, run.id, seed, rules).lines.length;
    } catch {
      throw new HttpError(400, "Invalid run.");
    }
    if (line >= lines) throw new HttpError(400, "Invalid line.");

    const r = await voiceLine(kind, run.id, seed, kind === "rogue", line, { client: clientIp(req), signal: req.signal }, rules);
    return NextResponse.json({ enabled: true, texts: r.texts, model: r.model, ms: r.ms });
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error("voice route", e);
    // Voices are optional: the page plays the original lines.
    return NextResponse.json({ enabled: true, texts: {} });
  }
}
