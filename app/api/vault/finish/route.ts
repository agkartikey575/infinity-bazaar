import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { checkOrigin, cookieOptions, fail, HttpError, paypalClient, setupId, SETUP_COOKIE, VAULT_COOKIE } from "../../../../lib/server/http.ts";
import { signValue } from "../../../../lib/server/ledger.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Step 2: you approved in PayPal; save the wallet so the agent can pay with no one present. */
export async function POST(req: NextRequest) {
  try {
    checkOrigin(req);
    const paypal = paypalClient();
    const setup = setupId(req);
    if (!paypal || !setup) return NextResponse.json({ error: "No wallet connection in progress." }, { status: 400 });
    const body = (await req.json().catch(() => ({}))) as { token?: string | null };
    // PayPal returns the approved setup token; it must be the one this browser started.
    if (body.token && body.token !== setup) throw new HttpError(400, "That approval belongs to a different wallet connection.");
    const res = await paypal.createPaymentToken(setup, `vault-finish-${setup}`);
    const out = NextResponse.json({ wallet: true });
    out.cookies.set(VAULT_COOKIE, signValue("vault", res.data.id), cookieOptions(req, 60 * 60 * 24 * 30));
    out.cookies.delete(SETUP_COOKIE);
    return out;
  } catch (e) {
    return fail(e);
  }
}
