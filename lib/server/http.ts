// Shared plumbing for the API routes: parse the request, check the ledger
// signature, and turn errors into JSON the deal room can show.
import { NextResponse, type NextRequest } from "next/server";
import { readLedger, readValue, signLedger, type Ledger, type RunRef } from "./ledger.ts";
import { configFromEnv, PayPalClient, PayPalError } from "./paypal.ts";

const KINDS = new Set(["mission", "single", "rogue"]);
export const VAULT_COOKIE = "ib_vault";
export const SETUP_COOKIE = "ib_setup";

let client: PayPalClient | null | undefined;
/** One client per server instance, so the access token is cached between requests. */
export function paypalClient(): PayPalClient | null {
  if (client === undefined) {
    const cfg = configFromEnv();
    client = cfg ? new PayPalClient(cfg) : null;
  }
  return client;
}

export interface AgentBody {
  run: RunRef;
  line: number;
  ledger: Ledger;
  userApproved?: boolean;
}

export async function readBody(req: NextRequest): Promise<AgentBody> {
  const body = (await req.json()) as { run?: RunRef; line?: number; ledger?: string; userApproved?: boolean };
  const run = body.run;
  if (!run || !KINDS.has(run.kind) || typeof run.id !== "string" || !Number.isInteger(run.seed) || run.seed < 1) throw new HttpError(400, "Invalid run.");
  if (!Number.isInteger(body.line) || (body.line as number) < 0) throw new HttpError(400, "Invalid line.");
  const ledger = readLedger(body.ledger, { kind: run.kind, id: run.id, seed: run.seed });
  if (!ledger) throw new HttpError(400, "The payment ledger was changed or belongs to another run.");
  return { run: { kind: run.kind, id: run.id, seed: run.seed }, line: body.line as number, ledger, userApproved: body.userApproved === true };
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const vaultId = (req: NextRequest) => readValue(req.cookies.get(VAULT_COOKIE)?.value);

/** JSON reply that re-signs the ledger the browser will send back next time. */
export function ok(data: Record<string, unknown> & { ledger?: Ledger }) {
  const { ledger, ...rest } = data;
  return NextResponse.json({ ...rest, ...(ledger ? { ledger: signLedger(ledger) } : {}) });
}

export function fail(e: unknown) {
  if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
  if (e instanceof PayPalError) return NextResponse.json({ error: e.message, debugId: e.debugId, issue: e.issue }, { status: 502 });
  return NextResponse.json({ error: e instanceof Error ? e.message : "Unexpected error" }, { status: 500 });
}
