// A decline lasts at PayPal: once you decline a line, a resent older ledger
// can't get it paid later, so your budget holds even against replayed ledgers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { complete, declineAtPayPal, deliver, pay } from "../lib/server/agent.ts";
import { emptyLedger, transition, type Ledger, type RunRef } from "../lib/server/ledger.ts";
import { PayPalClient } from "../lib/server/paypal.ts";

/** A fake PayPal with state: a reused request id returns the original order, as PayPal does. */
function fakePayPal() {
  const calls: { method: string; path: string; requestId: string | null; body: any }[] = [];
  const byRequest = new Map<string, string>();
  const orders = new Map<string, { id: string; status: string; intent: string; reference_id: string; custom_id?: string; payments?: unknown }>();
  const view = (o: NonNullable<ReturnType<typeof orders.get>>) => ({
    id: o.id,
    status: o.status,
    purchase_units: [{ reference_id: o.reference_id, ...(o.custom_id ? { custom_id: o.custom_id } : {}), ...(o.payments ? { payments: o.payments } : {}) }],
    links: o.status === "COMPLETED" ? [] : [{ rel: "payer-action", href: `https://sandbox.example/approve/${o.id}` }],
  });
  const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" && /^[[{]/.test(init.body) ? JSON.parse(init.body) : null;
    calls.push({ method, path: u.pathname, requestId: headers.get("PayPal-Request-Id"), body });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "paypal-debug-id": "dbg" } });
    if (u.pathname === "/v1/oauth2/token") return json({ access_token: "tok", expires_in: 3600 });
    if (u.pathname === "/v2/checkout/orders" && method === "POST") {
      const rid = headers.get("PayPal-Request-Id")!;
      let id = byRequest.get(rid);
      if (!id) {
        id = `ORDER${orders.size + 1}`;
        byRequest.set(rid, id);
        const pu = body.purchase_units[0];
        orders.set(id, { id, status: "PAYER_ACTION_REQUIRED", intent: body.intent, reference_id: pu.reference_id, custom_id: pu.custom_id });
      }
      return json(view(orders.get(id)!), 201);
    }
    const one = u.pathname.match(/^\/v2\/checkout\/orders\/(\w+)$/);
    if (one && method === "GET") return json(view(orders.get(one[1])!));
    if (one && method === "PATCH") {
      for (const op of body) if (String(op.path).endsWith("/custom_id")) orders.get(one[1])!.custom_id = op.value;
      return new Response(null, { status: 204 });
    }
    const act = u.pathname.match(/^\/v2\/checkout\/orders\/(\w+)\/(capture|authorize)$/);
    if (act) {
      const o = orders.get(act[1])!;
      if (o.status !== "APPROVED") return json({ name: "UNPROCESSABLE_ENTITY", message: "not approved", details: [{ issue: "ORDER_NOT_APPROVED" }] }, 422);
      o.status = "COMPLETED";
      o.payments = act[2] === "capture" ? { captures: [{ id: `CAP-${o.id}`, status: "COMPLETED" }] } : { authorizations: [{ id: `AUTH-${o.id}`, status: "CREATED" }] };
      return json(view(o), 201);
    }
    const auth = u.pathname.match(/^\/v2\/payments\/authorizations\/([\w-]+)\/(capture|void)$/);
    if (auth) return auth[2] === "capture" ? json({ id: `CAP2-${auth[1]}`, status: "COMPLETED" }, 201) : new Response(null, { status: 204 });
    return json({ name: "NOT_FOUND", message: u.pathname }, 404);
  };
  const client = new PayPalClient({ base: "https://paypal.test", clientId: "id", secret: "secret", fetch: fetchFn as typeof fetch, timeoutMs: 200, backoffMs: 1 });
  /** The buyer approves an order in the PayPal window. */
  const approve = (id: string) => (orders.get(id)!.status = "APPROVED");
  /** Capture or authorize calls on an order: money moving, or set aside. */
  const moved = (id: string) => calls.filter((c) => c.path === `/v2/checkout/orders/${id}/capture` || c.path === `/v2/checkout/orders/${id}/authorize`).length;
  return { client, calls, orders, approve, moved };
}

const ref = (budgetUsd: number, askAboveUsd: number, nonce: string): RunRef => ({ kind: "mission", id: "hackathon-10-days", seed: 42, nonce, rules: { budgetUsd, askAboveUsd } });

/** Pays a line the way the deal room does: approve in PayPal when asked, then settle delivery. */
async function payThrough(r: RunRef, line: number, ledger: Ledger, userApproved: boolean, pp: ReturnType<typeof fakePayPal>) {
  const ctx = { paypal: pp.client, vaultId: null, returnUrl: "https://app/paypal/return" };
  const res = await pay(r, line, ledger, userApproved, ctx);
  if (res.decision !== "needs_paypal_approval") return { decision: res.decision as string, ledger: res.ledger, paid: 0 };
  pp.approve(res.orderId);
  const done = await complete(r, line, res.ledger, pp.client);
  assert.ok(!("needsApproval" in done));
  let l = done.ledger;
  if (done.state === "authorized") l = (await deliver(r, line, l, pp.client)).ledger;
  return { decision: l.entries[line].state, ledger: l, paid: l.entries[line].state === "captured" ? l.entries[line].amountCents : 0 };
}

test("budget $120 / ask $40: a declined line replayed with no ledger is refused, nothing captured", async () => {
  const pp = fakePayPal();
  const r = ref(120, 40, "replayone01");
  const d0 = await declineAtPayPal(r, 0, emptyLedger(r), pp.client, "https://app/paypal/return");
  assert.equal(d0.state, "declined");
  assert.equal(d0.log[0].text, "You declined. No money moved.");
  const marker = d0.ledger.entries[0].orderId!;
  assert.equal(pp.orders.get(marker)!.custom_id, "declined", "the line's order at PayPal is marked declined");
  assert.equal(pp.calls.find((c) => c.method === "POST" && c.path === "/v2/checkout/orders")!.requestId, `${r.nonce}-0:create`, "same request id as a real order");

  // Decline, then carry on: the next item is paid and the last one is blocked, as on screen.
  const p1 = await payThrough(r, 1, d0.ledger, true, pp);
  assert.equal(p1.decision, "captured");
  assert.equal(p1.paid, 9700);
  const p2 = await payThrough(r, 2, p1.ledger, false, pp);
  assert.equal(p2.decision, "block");
  assert.equal(p2.ledger.entries[2].state, "blocked");

  // The replay: line 0 again, with no ledger at all, and your OK.
  const replay = await pay(r, 0, emptyLedger(r), true, { paypal: pp.client, vaultId: null, returnUrl: "https://app/paypal/return" });
  assert.equal(replay.decision, "declined");
  assert.equal(replay.ledger.entries[0].state, "declined");
  assert.match(replay.log.at(-1)!.text, /You declined this payment earlier/);
  assert.equal(pp.moved(marker), 0, "the declined order is never captured or authorized");
  // Even if a buyer somehow approved it, completing it is refused.
  pp.approve(marker);
  const pending = transition(emptyLedger(r), 0, { state: "pending_approval", amountCents: 4200, orderId: marker });
  const c = await complete(r, 0, pending, pp.client);
  assert.equal((c as { state: string }).state, "declined");
  assert.equal(pp.moved(marker), 0);
});

test("budget $150 / ask $50: a declined line replayed with an older ledger is refused", async () => {
  const pp = fakePayPal();
  const r = ref(150, 50, "replaytwo01");
  const p0 = await payThrough(r, 0, emptyLedger(r), false, pp);
  assert.equal(p0.decision, "captured");
  const L1 = p0.ledger;
  const d1 = await declineAtPayPal(r, 1, L1, pp.client, "https://app/paypal/return");
  const marker = d1.ledger.entries[1].orderId!;
  const p2 = await payThrough(r, 2, d1.ledger, false, pp);
  assert.equal(p2.decision, "captured");
  // The replay: line 1 with the older ledger, from before the decline.
  const replay = await pay(r, 1, L1, true, { paypal: pp.client, vaultId: null, returnUrl: "https://app/paypal/return" });
  assert.equal(replay.decision, "declined");
  assert.equal(pp.moved(marker), 0);
  const total = [p0, p2].reduce((s, p) => s + p.paid, 0);
  assert.ok(total <= 15000, `within the $150 budget: ${total / 100}`);
});

test("Cancel in the PayPal window marks the waiting order declined, and it stays declined", async () => {
  const pp = fakePayPal();
  const r = ref(120, 40, "cancelpath1");
  const ctx = { paypal: pp.client, vaultId: null, returnUrl: "https://app/paypal/return" };
  const res = await pay(r, 0, emptyLedger(r), true, ctx);
  assert.equal(res.decision, "needs_paypal_approval");
  const orderId = (res as { orderId: string }).orderId;
  const d = await declineAtPayPal(r, 0, res.ledger, pp.client);
  assert.equal(d.state, "declined");
  const patch = pp.calls.find((c) => c.method === "PATCH");
  assert.ok(patch, "the order was patched");
  assert.equal(patch.path, `/v2/checkout/orders/${orderId}`);
  assert.deepEqual(patch.body, [{ op: "replace", path: `/purchase_units/@reference_id=='${r.nonce}-0'/custom_id`, value: "declined" }]);
  assert.equal(pp.orders.get(orderId)!.custom_id, "declined");
  // Resuming or completing with the older ledger, where the order still waits, is refused.
  pp.approve(orderId);
  const resumed = await pay(r, 0, res.ledger, true, ctx);
  assert.equal(resumed.decision, "declined");
  const c = await complete(r, 0, res.ledger, pp.client);
  assert.equal((c as { state: string }).state, "declined");
  assert.equal(pp.moved(orderId), 0);
});

test("no decline: orders carry no mark and nothing is patched", async () => {
  const pp = fakePayPal();
  const r = ref(300, 100, "nodecline01");
  let ledger = emptyLedger(r);
  for (const line of [0, 1, 2]) ledger = (await payThrough(r, line, ledger, true, pp)).ledger;
  assert.deepEqual([0, 1, 2].map((i) => ledger.entries[i].state), ["captured", "captured", "captured"]);
  assert.equal(pp.calls.filter((c) => c.method === "PATCH").length, 0);
  assert.ok(pp.calls.filter((c) => c.path === "/v2/checkout/orders").every((c) => c.body.purchase_units[0].custom_id === undefined));
});

test("demo mode: a decline needs no PayPal and still reads as no money moved", async () => {
  const r = ref(120, 40, "demodecl001");
  const d = await declineAtPayPal(r, 0, emptyLedger(r), null);
  assert.equal(d.state, "declined");
  assert.equal(d.ledger.entries[0].state, "declined");
  assert.equal(d.log[0].text, "You declined. No money moved.");
});
