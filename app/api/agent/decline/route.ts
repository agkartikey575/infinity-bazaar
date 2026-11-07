import type { NextRequest } from "next/server";
import { declineLine } from "../../../../lib/server/agent.ts";
import { fail, ok, readBody } from "../../../../lib/server/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Room for PayPal timeouts and one retry, so a slow call fails cleanly instead of being cut off. */
export const maxDuration = 60;

/** You declined, here or in PayPal. Nothing moves; an unapproved order simply expires. */
export async function POST(req: NextRequest) {
  try {
    const b = await readBody(req);
    return ok({ ledger: declineLine(b.run, b.line, b.ledger), log: [{ text: "You declined. No money moved.", tone: "bad" }] });
  } catch (e) {
    return fail(e);
  }
}
