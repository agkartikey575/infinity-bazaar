// The payment ledger for one run, signed by the server so the browser can hold
// it without being able to change it. Works on serverless hosts with no database.
import { createHmac, createHash, timingSafeEqual } from "node:crypto";

export type RunRef = { kind: "mission" | "single" | "rogue"; id: string; seed: number };

export type EntryState = "pending_approval" | "authorized" | "captured" | "voided" | "declined" | "blocked";

export interface LedgerEntry {
  state: EntryState;
  amountCents: number;
  orderId?: string;
  authorizationId?: string;
  captureId?: string;
  /** Request ids sent to PayPal for this line, so retries reuse them. */
  requestIds?: string[];
}

export interface Ledger {
  v: 1;
  run: RunRef;
  entries: Record<string, LedgerEntry>;
}

/** Allowed state changes. Anything else is a bug or tampering, and throws. */
const NEXT: Record<EntryState | "none", EntryState[]> = {
  none: ["pending_approval", "authorized", "captured", "declined", "blocked"],
  pending_approval: ["authorized", "captured", "declined"],
  authorized: ["captured", "voided"],
  captured: [],
  voided: [],
  declined: [],
  blocked: [],
};

export function emptyLedger(run: RunRef): Ledger {
  return { v: 1, run, entries: {} };
}

export function transition(l: Ledger, line: number, next: LedgerEntry): Ledger {
  const cur = l.entries[line]?.state ?? "none";
  if (!NEXT[cur].includes(next.state)) throw new Error(`ledger: line ${line} cannot go from ${cur} to ${next.state}`);
  return { ...l, entries: { ...l.entries, [line]: { ...l.entries[line], ...next } } };
}

/** Money held or paid, plus orders waiting for the buyer: what the budget must cover. */
export function committedCents(l: Ledger): number {
  return Object.values(l.entries).reduce((sum, e) => sum + (e.state === "authorized" || e.state === "captured" || e.state === "pending_approval" ? e.amountCents : 0), 0);
}

export function ledgerSecret(env: Record<string, string | undefined> = process.env): string {
  if (env.LEDGER_SECRET) return env.LEDGER_SECRET;
  // Derived from the PayPal secret so a deploy needs no extra setting; a fixed dev key otherwise.
  return createHash("sha256").update(`infinity-bazaar-ledger:${env.PAYPAL_CLIENT_SECRET ?? "dev-only"}`).digest("hex");
}

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const mac = (body: string, secret: string) => createHmac("sha256", secret).update(body).digest("base64url");

export function signLedger(l: Ledger, secret = ledgerSecret()): string {
  const body = b64(JSON.stringify(l));
  return `${body}.${mac(body, secret)}`;
}

/** Returns the ledger, or null if the token was forged, edited, or is for another run. */
export function readLedger(token: string | undefined | null, run: RunRef, secret = ledgerSecret()): Ledger | null {
  if (!token) return emptyLedger(run);
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const want = Buffer.from(mac(body, secret));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  const l = JSON.parse(Buffer.from(body, "base64url").toString()) as Ledger;
  const same = l.run.kind === run.kind && l.run.id === run.id && l.run.seed === run.seed;
  return same ? l : null;
}

/** A small signed value (the saved wallet's vault id) for an httpOnly cookie. */
export function signValue(value: string, secret = ledgerSecret()): string {
  const body = b64(value);
  return `${body}.${mac(body, secret)}`;
}

export function readValue(token: string | undefined | null, secret = ledgerSecret()): string | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig || mac(body, secret) !== sig) return null;
  return Buffer.from(body, "base64url").toString();
}
