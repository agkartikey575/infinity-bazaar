import type { NextRequest } from "next/server";
import { deliver } from "../../../../lib/server/agent.ts";
import { fail, ok, paypalClient, readBody } from "../../../../lib/server/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Room for PayPal timeouts and one retry, so a slow call fails cleanly instead of being cut off. */
export const maxDuration = 60;

/** Delivery result, decided on the server: capture the held money, or void the hold. */
export async function POST(req: NextRequest) {
  try {
    const b = await readBody(req);
    return ok(await deliver(b.run, b.line, b.ledger, paypalClient()));
  } catch (e) {
    return fail(e);
  }
}
