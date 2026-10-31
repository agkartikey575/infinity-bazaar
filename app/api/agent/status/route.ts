import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { paypalClient, vaultId } from "../../../../lib/server/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Whether real PayPal sandbox calls are available, and whether a wallet is saved. */
export function GET(req: NextRequest) {
  const paypal = paypalClient();
  // Warm the PayPal access token while the page loads, so the first payment skips that round trip.
  paypal?.accessToken().catch(() => undefined);
  return NextResponse.json({ mode: paypal ? "sandbox" : "simulated", wallet: vaultId(req) !== null });
}
