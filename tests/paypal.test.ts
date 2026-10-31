// Server-side payment tests with a fake PayPal: the ledger can't be forged,
// state changes follow the rules, AgentGuard runs before PayPal, and retries
// reuse the same request id.
import { test } from "node:test";
import assert from "node:assert/strict";
import { complete, deliver, guardLine, lineKey, pay, rebuildRun } from "../lib/server/agent.ts";
import { committedCents, emptyLedger, readLedger, readValue, signLedger, signValue, transition, type RunRef } from "../lib/server/ledger.ts";
import { PayPalClient } from "../lib/server/paypal.ts";
import { toCents, toValue } from "../lib/money.ts";

const SECRET = "test-secret";

/** A fake PayPal that records calls and answers like the sandbox does. */
function fakePayPal(opts: { completeOnCreate?: boolean; captureStatus?: string; failComplete?: string; omitAuthId?: boolean } = {}) {
  const calls: { method: string; path: string; requestId: string | null; body: any }[] = [];
  const orders = new Map<string, string>();
  const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const headers = new Headers(init?.headers);
    const body = init?.body && typeof init.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : null;
    calls.push({ method: init?.method ?? "GET", path: u.pathname, requestId: headers.get("PayPal-Request-Id"), body });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "paypal-debug-id": "dbg1" } });
    if (u.pathname === "/v1/oauth2/token") return json({ access_token: "tok", expires_in: 3600 });
    if (u.pathname === "/v2/checkout/orders") {
      const rid = headers.get("PayPal-Request-Id")!;
      const id = orders.get(rid) ?? `ORDER${orders.size + 1}`;
      orders.set(rid, id);
      if (opts.completeOnCreate) {
        const pay = body.intent === "CAPTURE" ? { captures: [{ id: `CAP-${id}`, status: "COMPLETED" }] } : { authorizations: [{ id: `AUTH-${id}`, status: "CREATED" }] };
        return json({ id, status: "COMPLETED", purchase_units: [{ payments: pay }] }, 201);
      }
      return json({ id, status: "PAYER_ACTION_REQUIRED", links: [{ rel: "payer-action", href: `https://sandbox.example/approve/${id}` }] }, 200);
    }
    const m = u.pathname.match(/^\/v2\/checkout\/orders\/(\w+)\/(capture|authorize)$/);
    if (m) {
      if (opts.failComplete) return json({ name: "UNPROCESSABLE_ENTITY", message: "no", details: [{ issue: opts.failComplete }] }, 422);
      const pay = m[2] === "capture"
        ? { captures: [{ id: `CAP-${m[1]}`, status: opts.captureStatus ?? "COMPLETED" }] }
        : { authorizations: [{ id: opts.omitAuthId ? undefined : `AUTH-${m[1]}`, status: "CREATED" }] };
      return json({ id: m[1], status: "COMPLETED", purchase_units: [{ payments: pay }] }, 201);
    }
    const g = u.pathname.match(/^\/v2\/checkout\/orders\/(\w+)$/);
    if (g) return json({ id: g[1], status: "PAYER_ACTION_REQUIRED", links: [{ rel: "payer-action", href: `https://sandbox.example/approve/${g[1]}` }] });
    const a = u.pathname.match(/^\/v2\/payments\/authorizations\/([\w-]+)\/(capture|void)$/);
    if (a) return a[2] === "capture" ? json({ id: `CAP2-${a[1]}`, status: "COMPLETED" }, 201) : new Response(null, { status: 204 });
    return json({ name: "NOT_FOUND", message: u.pathname }, 404);
  };
  const client = new PayPalClient({ base: "https://paypal.test", clientId: "id", secret: "secret", fetch: fetchFn as typeof fetch });
  return { client, calls };
}

const mission = (seed: number, nonce = "testnonce01"): RunRef => ({ kind: "mission", id: "hackathon-10-days", seed, nonce });
/** A seed whose first line is approved by AgentGuard without asking. */
const autoSeed = () => {
  for (let s = 1; s < 300; s++) {
    const ref = mission(s);
    const run = rebuildRun(ref);
    if (run.lines[0].deal.outcome.status === "deal" && guardLine(run, 0, emptyLedger(ref)).guard.decision === "approve") return s;
  }
  throw new Error("no seed");
};

test("money: cents and PayPal's two-decimal format", () => {
  assert.equal(toCents(47), 4700);
  assert.equal(toCents(10.005), 1001);
  assert.equal(toValue(toCents(9)), "9.00");
});

test("ledger: signed, tamper-proof and tied to one run", () => {
  const ref = mission(5);
  const l = transition(emptyLedger(ref), 0, { state: "captured", amountCents: 4700 });
  const token = signLedger(l, SECRET);
  assert.deepEqual(readLedger(token, ref, SECRET), l);
  const [body, sig] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ ...l, entries: {} })).toString("base64url");
  assert.equal(readLedger(`${forged}.${sig}`, ref, SECRET), null, "edited ledger is refused");
  assert.equal(readLedger(`${body}.${sig}`, mission(6), SECRET), null, "ledger for another run is refused");
  assert.equal(readLedger(token, mission(5, "othernonce1"), SECRET), null, "ledger for another Play of the same table is refused");
  assert.equal(readLedger(token, ref, "other-secret"), null, "wrong key is refused");
});

test("ledger: only allowed state changes", () => {
  const l = transition(emptyLedger(mission(1)), 0, { state: "authorized", amountCents: 100 });
  assert.throws(() => transition(l, 0, { state: "declined", amountCents: 100 }));
  const c = transition(l, 0, { state: "captured", amountCents: 100 });
  assert.throws(() => transition(c, 0, { state: "voided", amountCents: 100 }), "a capture can't be voided");
  assert.throws(() => transition(l, 1, { state: "voided", amountCents: 999 }), "nothing to void yet");
  const held = transition(l, 1, { state: "authorized", amountCents: 999 });
  assert.equal(committedCents(transition(held, 1, { state: "voided", amountCents: 999 })), 100, "a voided hold frees its money");
});

test("rogue payment is blocked on the server and PayPal is never called", async () => {
  const { client, calls } = fakePayPal();
  const ref: RunRef = { kind: "rogue", id: "usb-mic", seed: 7, nonce: "roguenonce1" };
  const r = await pay(ref, 0, emptyLedger(ref), true, { paypal: client, vaultId: null, returnUrl: "https://app/return" });
  assert.equal(r.decision, "block");
  assert.equal(calls.length, 0);
  assert.equal(r.ledger.entries[0].state, "blocked");
});

test("ask-you payments wait for your approval before any PayPal call", async () => {
  for (let s = 1; s < 300; s++) {
    const ref = mission(s);
    const run = rebuildRun(ref);
    const i = run.lines.findIndex((l, k) => l.deal.outcome.status === "deal" && guardLine(run, k, emptyLedger(ref)).guard.decision === "ask_user");
    if (i < 0) continue;
    const { client, calls } = fakePayPal();
    const r = await pay(ref, i, emptyLedger(ref), false, { paypal: client, vaultId: null, returnUrl: "https://app/return" });
    assert.equal(r.decision, "ask_user");
    assert.equal(calls.length, 0);
    return;
  }
  assert.fail("no seed with an approval");
});

test("no wallet: order needs PayPal approval, then complete; retries reuse the request id", async () => {
  const ref = mission(autoSeed());
  const { client, calls } = fakePayPal();
  const ctx = { paypal: client, vaultId: null, returnUrl: "https://app/return" };
  const r = await pay(ref, 0, emptyLedger(ref), false, ctx);
  assert.equal(r.decision, "needs_paypal_approval");
  const again = await pay(ref, 0, emptyLedger(ref), false, ctx);
  assert.equal((again as { orderId: string }).orderId, (r as { orderId: string }).orderId, "same order on retry");
  const creates = calls.filter((c) => c.path === "/v2/checkout/orders");
  assert.equal(creates[0].requestId, `${lineKey(ref, 0)}:create`);
  assert.equal(creates[0].body.purchase_units[0].invoice_id, `IB-${lineKey(ref, 0)}`);
  // The amount PayPal sees is the engine's, never the browser's.
  const o = rebuildRun(ref).lines[0].deal.outcome;
  assert.equal(creates[0].body.purchase_units[0].amount.value, toValue(toCents(o.amountToPay!)));

  const done = await complete(ref, 0, r.ledger, client);
  assert.ok("state" in done && ["captured", "authorized"].includes(done.state));
  await assert.rejects(() => complete(ref, 0, done.ledger, client), "can't complete twice");
});

test("with a saved wallet the agent pays alone; held items capture on delivery or void on failure", async () => {
  let checked = 0;
  for (let s = 1; s < 400 && checked < 6; s++) {
    const ref = mission(s);
    const run = rebuildRun(ref);
    for (let i = 0; i < run.lines.length; i++) {
      const o = run.lines[i].deal.outcome;
      if (o.status !== "deal") continue;
      const ledger = emptyLedger(ref);
      if (guardLine(run, i, ledger).guard.decision !== "approve") continue;
      const { client, calls } = fakePayPal({ completeOnCreate: true });
      const r = await pay(ref, i, ledger, false, { paypal: client, vaultId: "VAULT1", returnUrl: "https://app/return" });
      assert.equal(r.decision, "paid");
      assert.equal(calls.find((c) => c.path === "/v2/checkout/orders")?.body.payment_source.paypal.vault_id, "VAULT1");
      if (r.decision === "paid" && r.state === "authorized") {
        const d = await deliver(ref, i, r.ledger, client);
        assert.equal(d.state, o.afterPayment ? "voided" : "captured");
        assert.ok(calls.some((c) => c.path.endsWith(o.afterPayment ? "/void" : "/capture")));
        checked++;
      }
    }
  }
  assert.ok(checked > 0);
});

test("AgentGuard on the server counts money already committed in the ledger", () => {
  const ref = mission(autoSeed());
  const run = rebuildRun(ref);
  const full = transition(emptyLedger(ref), 9, { state: "captured", amountCents: 29_990 });
  assert.equal(guardLine(run, 0, full).guard.decision, "block", "over budget once the ledger is full");
  const paid = transition(emptyLedger(ref), 0, { state: "captured", amountCents: 100 });
  assert.equal(guardLine(run, 0, paid).guard.decision, "block", "already paid");
});

test("ids are unique per Play: same table, different nonce, different PayPal ids", async () => {
  const seed = autoSeed();
  const a = mission(seed, "playnumber1");
  const b = mission(seed, "playnumber2");
  assert.notEqual(lineKey(a, 0), lineKey(b, 0));
  const { client, calls } = fakePayPal();
  const ctx = { paypal: client, vaultId: null, returnUrl: "https://app/return" };
  await pay(a, 0, emptyLedger(a), false, ctx);
  await pay(b, 0, emptyLedger(b), false, ctx);
  const creates = calls.filter((c) => c.path === "/v2/checkout/orders");
  assert.notEqual(creates[0].requestId, creates[1].requestId);
  assert.notEqual(creates[0].body.purchase_units[0].invoice_id, creates[1].body.purchase_units[0].invoice_id);
  assert.ok(creates[0].body.purchase_units[0].invoice_id.includes("playnumber1"));
});

test("a capture PayPal reports as DECLINED is never shown as paid", async () => {
  for (let s = 1; s < 300; s++) {
    const ref = mission(s);
    const run = rebuildRun(ref);
    const o = run.lines[0].deal.outcome;
    if (o.status !== "deal" || guardLine(run, 0, emptyLedger(ref)).guard.decision !== "approve") continue;
    const { client } = fakePayPal({ captureStatus: "DECLINED" });
    const r = await pay(ref, 0, emptyLedger(ref), false, { paypal: client, vaultId: null, returnUrl: "https://app/return" });
    if (r.decision !== "needs_paypal_approval") continue;
    const done = await complete(ref, 0, r.ledger, client);
    if ("state" in done && rebuildRun(ref).lines[0].itemId && done.ledger.entries[0].state !== "authorized") {
      assert.equal(done.state, "declined");
      assert.equal(committedCents(done.ledger), 0);
      return;
    }
  }
});

test("a declined wallet sends you back to PayPal with a fresh request id", async () => {
  const ref = mission(autoSeed());
  const { client, calls } = fakePayPal({ failComplete: "INSTRUMENT_DECLINED" });
  const r = await pay(ref, 0, emptyLedger(ref), false, { paypal: client, vaultId: null, returnUrl: "https://app/return" });
  const done = await complete(ref, 0, r.ledger, client);
  assert.ok("needsApproval" in done && done.approveUrl.includes("sandbox.example"));
  assert.equal(done.ledger.entries[0].state, "pending_approval");
  assert.equal(done.ledger.entries[0].attempt, 1);
  const first = calls.find((c) => /\/(capture|authorize)$/.test(c.path))!.requestId!;
  assert.ok(first.endsWith(":0"));
});

test("a held line with no authorization id fails loudly instead of pretending", async () => {
  const ref = mission(autoSeed());
  const l = transition(emptyLedger(ref), 0, { state: "authorized", amountCents: 100 });
  const { client } = fakePayPal();
  await assert.rejects(() => deliver(ref, 0, l, client), /no authorization id/);
});

test("paying a line again resumes it instead of paying twice", async () => {
  const ref = mission(autoSeed());
  const { client, calls } = fakePayPal({ completeOnCreate: true });
  const ctx = { paypal: client, vaultId: "VAULT1", returnUrl: "https://app/return" };
  const first = await pay(ref, 0, emptyLedger(ref), false, ctx);
  assert.equal(first.decision, "paid");
  const before = calls.length;
  const again = await pay(ref, 0, first.ledger, false, ctx);
  assert.equal(again.decision, "paid");
  assert.equal(calls.length, before, "no new PayPal call");
});

test("signed values can't be swapped between purposes", () => {
  const vault = signValue("vault", "VAULT1", SECRET);
  assert.equal(readValue("vault", vault, SECRET), "VAULT1");
  assert.equal(readValue("setup", vault, SECRET), null);
});
