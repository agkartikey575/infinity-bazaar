import type { NextRequest } from "next/server";
import { pay } from "../../../../lib/server/agent.ts";
import { fail, ok, paypalClient, readBody, vaultId } from "../../../../lib/server/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** AgentGuard on the server, then PayPal. Blocked payments never reach PayPal. */
export async function POST(req: NextRequest) {
  try {
    const b = await readBody(req);
    const returnUrl = `${new URL(req.url).origin}/paypal/return`;
    const result = await pay(b.run, b.line, b.ledger, b.userApproved ?? false, { paypal: paypalClient(), vaultId: vaultId(req), returnUrl });
    return ok(result);
  } catch (e) {
    return fail(e);
  }
}
