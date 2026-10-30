import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { fail, paypalClient, SETUP_COOKIE, VAULT_COOKIE } from "../../../../lib/server/http.ts";
import { readValue, signValue } from "../../../../lib/server/ledger.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Step 2: you approved in PayPal; save the wallet so the agent can pay with no one present. */
export async function POST(req: NextRequest) {
  try {
    const paypal = paypalClient();
    const setup = readValue(req.cookies.get(SETUP_COOKIE)?.value);
    if (!paypal || !setup) return NextResponse.json({ error: "No wallet connection in progress." }, { status: 400 });
    const res = await paypal.createPaymentToken(setup, `vault-finish-${setup}`);
    const out = NextResponse.json({ wallet: true });
    out.cookies.set(VAULT_COOKIE, signValue(res.data.id), { httpOnly: true, sameSite: "lax", secure: true, path: "/", maxAge: 60 * 60 * 24 * 30 });
    out.cookies.delete(SETUP_COOKIE);
    return out;
  } catch (e) {
    return fail(e);
  }
}
