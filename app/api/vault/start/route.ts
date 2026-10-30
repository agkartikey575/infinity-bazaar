import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { approveLink } from "../../../../lib/server/paypal.ts";
import { fail, paypalClient, SETUP_COOKIE } from "../../../../lib/server/http.ts";
import { signValue } from "../../../../lib/server/ledger.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Step 1 of connecting your PayPal wallet to the agent: get an approval link. */
export async function POST(req: NextRequest) {
  try {
    const paypal = paypalClient();
    if (!paypal) return NextResponse.json({ error: "PayPal sandbox is not configured on this server." }, { status: 400 });
    const back = `${new URL(req.url).origin}/paypal/return?kind=wallet`;
    const res = await paypal.createSetupToken(back, `${back}&cancel=1`, `vault-${crypto.randomUUID()}`);
    const url = approveLink(res.data.links);
    if (!url) return NextResponse.json({ error: "PayPal returned no approval link." }, { status: 502 });
    const out = NextResponse.json({ approveUrl: url });
    out.cookies.set(SETUP_COOKIE, signValue(res.data.id), { httpOnly: true, sameSite: "lax", secure: true, path: "/", maxAge: 3600 });
    return out;
  } catch (e) {
    return fail(e);
  }
}
