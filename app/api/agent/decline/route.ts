import type { NextRequest } from "next/server";
import { decline, guardLine, rebuildRun } from "../../../../lib/server/agent.ts";
import { fail, ok, readBody } from "../../../../lib/server/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** You declined, here or in PayPal. Nothing moves; an unapproved order simply expires. */
export async function POST(req: NextRequest) {
  try {
    const b = await readBody(req);
    const { amount } = guardLine(rebuildRun(b.run), b.line, b.ledger);
    return ok({ ledger: decline(b.line, b.ledger, amount), log: [{ text: "You declined. No money moved." }] });
  } catch (e) {
    return fail(e);
  }
}
