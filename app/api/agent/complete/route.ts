import type { NextRequest } from "next/server";
import { complete } from "../../../../lib/server/agent.ts";
import { fail, ok, paypalClient, readBody } from "../../../../lib/server/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** After you approve in the PayPal window: capture or authorize the order. */
export async function POST(req: NextRequest) {
  try {
    const b = await readBody(req);
    return ok({ ...(await complete(b.run, b.line, b.ledger, paypalClient())) });
  } catch (e) {
    return fail(e);
  }
}
