// Shared plumbing for the API routes: parse the request, check the ledger
// signature, and turn errors into JSON the deal room can show.
import { NextResponse, type NextRequest } from "next/server";
import { readLedger, readValue, signLedger, type Ledger, type RunRef } from "./ledger.ts";
import { configFromEnv, PayPalClient, PayPalError } from "./paypal.ts";

const KINDS = new Set(["mission", "single", "rogue"]);
const NONCE = /^[a-z0-9]{8,40}$/;
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

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Only our own pages may call the payment routes, and only with JSON. */
export function checkOrigin(req: NextRequest) {
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(req.url).origin) throw new HttpError(403, "Requests must come from this site.");
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) throw new HttpError(415, "Send JSON.");
}

export interface AgentBody {
  run: RunRef;
  line: number;
  ledger: Ledger;
  userApproved: boolean;
}

export async function readBody(req: NextRequest): Promise<AgentBody> {
  checkOrigin(req);
  let body: { run?: RunRef; line?: number; ledger?: string; userApproved?: boolean };
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, "The request body is not valid JSON.");
  }
  if (body?.ledger !== undefined && body.ledger !== null && typeof body.ledger !== "string") throw new HttpError(400, "Invalid ledger.");
  const run = body?.run;
  if (!run || !KINDS.has(run.kind) || typeof run.id !== "string" || !Number.isSafeInteger(run.seed) || run.seed < 1 || run.seed > 999_999_999) throw new HttpError(400, "Invalid run.");
  if (typeof run.nonce !== "string" || !NONCE.test(run.nonce)) throw new HttpError(400, "Invalid run nonce.");
  if (!Number.isInteger(body.line) || (body.line as number) < 0) throw new HttpError(400, "Invalid line.");
  const ref: RunRef = { kind: run.kind, id: run.id, seed: run.seed, nonce: run.nonce };
  const ledger = readLedger(body.ledger, ref);
  if (!ledger) throw new HttpError(400, "The payment ledger was changed or belongs to another run.");
  return { run: ref, line: body.line as number, ledger, userApproved: body.userApproved === true };
}

export const vaultId = (req: NextRequest) => readValue("vault", req.cookies.get(VAULT_COOKIE)?.value);
export const setupId = (req: NextRequest) => readValue("setup", req.cookies.get(SETUP_COOKIE)?.value);

/** Cookies are Secure except on plain-http localhost, where browsers would drop them. */
export const cookieOptions = (req: NextRequest, maxAge: number) => ({
  httpOnly: true,
  sameSite: "lax" as const,
  secure: new URL(req.url).protocol === "https:",
  path: "/",
  maxAge,
});

/** JSON reply that re-signs the ledger the browser will send back next time. */
export function ok(data: Record<string, unknown> & { ledger?: Ledger }) {
  const { ledger, ...rest } = data;
  return NextResponse.json({ ...rest, ...(ledger ? { ledger: signLedger(ledger) } : {}) });
}

export function fail(e: unknown) {
  if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
  if (e instanceof PayPalError) return NextResponse.json({ error: e.message, debugId: e.debugId, issue: e.issue }, { status: 502 });
  const message = e instanceof Error ? e.message : "Unexpected error";
  // Engine and ledger errors are the caller's fault (a line with no deal, a bad transition).
  const client = /^(no line|line \d+|ledger:|Unknown (catalog item|mission))/.test(message);
  return NextResponse.json({ error: message }, { status: client ? 409 : 500 });
}
