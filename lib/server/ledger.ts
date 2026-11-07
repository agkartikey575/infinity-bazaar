// The payment ledger for one run, signed by the server so the browser can hold
// it without being able to change it. Works on serverless hosts with no database.
//
// What it guarantees: amounts, lines, states and your rules can't be edited,
// and a ledger can't be moved to another run or to other rules.
//
// What it doesn't: an older copy of the same run's ledger can be sent again,
// for example one from before you declined an item. That still can't take
// spending past the budget, because:
// - each line is paid at most once: its PayPal request id and invoice id are
//   fixed per Play and line, so a retry or replay gets the same order back;
// - the engine keeps each run's deals within the budget: with your own rules
//   it never plans past your budget, so even paying every deal in the run
//   (whatever was declined or blocked on another copy) stays within it;
// - the server counts every line the ledger doesn't prove unpaid as spent
//   (spentBefore in agent.ts), the same check the screen makes.
import { createHmac, timingSafeEqual } from "node:crypto";
import { sameRules, type PlayerRules } from "../rules.ts";

/**
 * A run is a deterministic deal plus a random nonce chosen each time you press Play,
 * and your own budget and approval limit when you set them (none means the defaults).
 */
export type RunRef = { kind: "mission" | "single" | "rogue"; id: string; seed: number; nonce: string; rules?: PlayerRules };

export type EntryState = "pending_approval" | "authorized" | "captured" | "voided" | "declined" | "blocked";

export interface LedgerEntry {
  state: EntryState;
  amountCents: number;
  orderId?: string;
  authorizationId?: string;
  captureId?: string;
  /** Attempts at the approval step; a declined wallet gets a fresh request id. */
  attempt?: number;
  /** PayPal accepted the payment but is still reviewing it. */
  review?: boolean;
}

export interface Ledger {
  v: 1;
  run: RunRef;
  entries: Record<string, LedgerEntry>;
}

/** Allowed state changes. Anything else is a bug or tampering, and throws. */
const NEXT: Record<EntryState | "none", EntryState[]> = {
  none: ["pending_approval", "authorized", "captured", "declined", "blocked"],
  pending_approval: ["pending_approval", "authorized", "captured", "declined"],
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
  return createHmac("sha256", "infinity-bazaar-ledger").update(env.PAYPAL_CLIENT_SECRET ?? "dev-only").digest("hex");
}

const b64 = (s: string) => Buffer.from(s).toString("base64url");
/** Each purpose gets its own MAC, so a cookie can't be passed off as a ledger. */
const mac = (purpose: string, body: string, secret: string) => createHmac("sha256", secret).update(`${purpose}:${body}`).digest("base64url");
const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function signLedger(l: Ledger, secret = ledgerSecret()): string {
  const body = b64(JSON.stringify(l));
  return `${body}.${mac("ledger", body, secret)}`;
}

/** Returns the ledger, or null if the token was forged, edited, or is for another run. */
export function readLedger(token: string | undefined | null, run: RunRef, secret = ledgerSecret()): Ledger | null {
  if (!token) return emptyLedger(run);
  const [body, sig] = token.split(".");
  if (!body || !sig || !same(mac("ledger", body, secret), sig)) return null;
  let l: Ledger;
  try {
    l = JSON.parse(Buffer.from(body, "base64url").toString()) as Ledger;
  } catch {
    return null;
  }
  // The rules are part of the run: a ledger signed under one budget can't be used under another.
  const match = l.run.kind === run.kind && l.run.id === run.id && l.run.seed === run.seed && l.run.nonce === run.nonce && sameRules(l.run.rules, run.rules);
  return match ? l : null;
}

/** A small signed value (setup token, vault id) for an httpOnly cookie. */
export function signValue(purpose: string, value: string, secret = ledgerSecret()): string {
  const body = b64(value);
  return `${body}.${mac(purpose, body, secret)}`;
}

export function readValue(purpose: string, token: string | undefined | null, secret = ledgerSecret()): string | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig || !same(mac(purpose, body, secret), sig)) return null;
  return Buffer.from(body, "base64url").toString();
}
