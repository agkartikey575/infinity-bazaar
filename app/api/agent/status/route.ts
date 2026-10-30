import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { paypalClient, vaultId } from "../../../../lib/server/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Whether real PayPal sandbox calls are available, and whether a wallet is saved. */
export function GET(req: NextRequest) {
  return NextResponse.json({ mode: paypalClient() ? "sandbox" : "simulated", wallet: vaultId(req) !== null });
}
