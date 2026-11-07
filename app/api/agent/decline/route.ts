import type { NextRequest } from "next/server";
import { declineAtPayPal } from "../../../../lib/server/agent.ts";
import { fail, ok, paypalClient, readBody } from "../../../../lib/server/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Room for PayPal timeouts and one retry, so a slow call fails cleanly instead of being cut off. */
export const maxDuration = 60;

/** You declined, here or in PayPal. Nothing moves; the line is marked declined at PayPal so it stays declined. */
export async function POST(req: NextRequest) {
  try {
    const b = await readBody(req);
    const d = await declineAtPayPal(b.run, b.line, b.ledger, paypalClient(), `${new URL(req.url).origin}/paypal/return`);
    return ok({ ledger: d.ledger, log: d.log, state: d.state });
  } catch (e) {
    return fail(e);
  }
}
