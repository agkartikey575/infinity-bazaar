// Your rules with real PayPal sandbox, in a real browser: the hackathon mission with
// budget $120 and ask above $40, opened from a shared link. With every ask approved,
// and again with the ask-you line declined, the statuses must match demo mode under the
// same rules, an item the engine skips for the budget must never reach PayPal, a declined
// line must never be approved or paid, every order's invoice id must carry the rules hash,
// and PayPal's captured total must equal the receipt and stay within the budget. Fake money only. Same setup as
// paypal-sandbox.e2e.mjs:
//   BASE_URL=https://infinity-bazaar.vercel.app \
//   PAYPAL_SANDBOX_BUYER_EMAIL=... PAYPAL_SANDBOX_BUYER_PASSWORD=... \
//   PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... \
//   node tests/e2e/paypal-sandbox-rules.e2e.mjs
import { createRequire } from "node:module";
import assert from "node:assert/strict";

import { buildMissionRun, buildSteps, deriveView } from "../../lib/timeline.ts";
import { getItem } from "../../src/engine/index.ts";
import { rulesTag } from "../../lib/server/agent.ts";
import { approveInPayPal, BASE_URL, panelReport, paymentStatus, paypalOrder, requireBuyer, savePopup, trackOrders } from "./paypal-helpers.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
requireBuyer();

const MISSION = "hackathon-10-days";
const RULES = { budgetUsd: 120, askAboveUsd: 40 };
const DEAL = 42;
const LABEL = { captured: "Paid", declined: "Declined", voided: "Hold released", blocked: "Blocked", "no-deal": "Walked away", skipped: "Skipped" };

/** Demo-mode outcome of the mission under your rules; the first ask is declined when `declineFirst`, every other ask approved. */
function expectedMission(seed, rules, declineFirst = false) {
  const run = buildMissionRun(MISSION, seed, rules);
  const decisions = {};
  for (;;) {
    const r = buildSteps(run, decisions);
    if (r.waitingFor === null) {
      const v = deriveView(run, r.steps, r.steps.length);
      return { run, statuses: v.statuses, pills: v.statuses.map((x) => LABEL[x] ?? x), paid: v.capturedUsd, asked: Object.keys(decisions).map(Number), decisions };
    }
    decisions[r.waitingFor] = declineFirst && !Object.keys(decisions).length ? "declined" : "approved";
  }
}

/** The receipt's "Paid $N" total, read with or without thousands commas. */
const receiptPaid = async (page) => Number((await page.locator(".receipt-head b").innerText()).match(/Paid \$([\d.,]+)/)?.[1].replace(/,/g, ""));

/** Opens the deal from a shared link with your rules, in PayPal sandbox mode. */
async function openWithRules(page) {
  await page.goto(`${BASE_URL}/?deal=${DEAL}&budget=${RULES.budgetUsd}&ask=${RULES.askAboveUsd}`, { waitUntil: "networkidle" });
  await page.getByLabel(/PayPal (\(sandbox\)|sandbox)/i).check();
  await page.selectOption("#speed", "4");
  assert.equal(await page.locator("#seed").inputValue(), String(DEAL), "deal from the link");
  assert.equal(await page.locator("#budget").inputValue(), String(RULES.budgetUsd), "budget from the link");
  assert.equal(await page.locator("#ask").inputValue(), String(RULES.askAboveUsd), "approval limit from the link");
}

/** Approves one PayPal window opened by clicking `opener`. */
async function payInPayPal(page, opener, n) {
  const [popup] = await Promise.all([page.waitForEvent("popup", { timeout: 30_000 }), opener.click()]);
  try {
    await approveInPayPal(popup);
  } catch (e) {
    await savePopup(popup, `rules-${n}`);
    throw e;
  }
}

/** Plays to the end: answers each ask-you sheet with `answer(n)` and approves every PayPal window. */
async function playLive(page, answer) {
  let windows = 0;
  let sheets = 0;
  const deadline = Date.now() + 8 * 60_000;
  for (;;) {
    assert.ok(Date.now() < deadline, "mission did not finish in time");
    if (/Replay/.test(await page.locator("header button.primary").innerText())) break;
    const dialog = page.getByRole("dialog");
    const approve = dialog.getByRole("button", { name: /^Approve/ });
    const payBtn = page.getByRole("button", { name: "Pay with PayPal" });
    if (await approve.isVisible().catch(() => false)) {
      if (answer(sheets++) === "declined") await dialog.getByRole("button", { name: "Decline" }).click();
      else await payInPayPal(page, approve, ++windows);
      continue;
    }
    if (await payBtn.isVisible().catch(() => false)) {
      await payInPayPal(page, payBtn, ++windows);
      continue;
    }
    if (await page.locator(".paypal .row-bad button", { hasText: "Retry" }).isVisible().catch(() => false)) throw new Error("the app shows a payment error");
    if (await page.locator(".paypal .row-ask button", { hasText: "Approve" }).isVisible().catch(() => false)) throw new Error("the server's AgentGuard asked for an OK that demo mode did not");
    await page.waitForTimeout(500);
  }
  return { windows, sheets };
}

const browser = await chromium.launch();
let failures = 0;

async function scenario(name, fn) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const state = { orders: {}, page: null };
  try {
    const summary = await fn(ctx, state);
    console.log(`ok - ${name}${summary ? ` (${summary})` : ""}`);
  } catch (e) {
    failures++;
    if (state.page) await state.page.screenshot({ path: "/tmp/paypal-rules.png", fullPage: true }).catch(() => undefined);
    const report = state.page ? await panelReport(state.page) : "";
    console.log(`not ok - ${name}\n  ${String(e.message).split("\n").join("\n  ")}\n  orders: ${JSON.stringify(state.orders)}\n  ${report}`);
  } finally {
    await ctx.close();
  }
}

/** With your rules, PayPal's invoice id is IB-<nonce>-<rules hash>-<line>, so other rules can never reuse the order. */
const TAG = rulesTag(RULES);
function checkInvoice(order, i) {
  const inv = order.purchase_units?.[0]?.invoice_id ?? "";
  assert.match(inv, new RegExp(`^IB-.+-${TAG}-${i}$`), `line ${i}: invoice id ${inv} carries the rules hash ${TAG}`);
}

/** Records the server's reply to every /api/agent/pay, by line. */
function trackPayReplies(page) {
  const replies = {};
  page.on("response", async (res) => {
    if (!res.url().endsWith("/api/agent/pay")) return;
    try {
      const line = JSON.parse(res.request().postData() ?? "{}").line;
      (replies[line] ??= []).push(await res.json());
    } catch {
      // not JSON, or the page went away
    }
  });
  return replies;
}

/**
 * Checks every line against PayPal's own records: a skipped line has no order and
 * never reached PayPal, a declined one has no approved, captured or authorized order,
 * and a paid or released one settled at the agreed amount. Returns what PayPal captured.
 */
async function checkLines(m, orders, payReplies) {
  const out = [];
  let charged = 0;
  for (const [i, line] of m.run.lines.entries()) {
    const id = orders[i];
    if (line.deal.outcome.budgetSkip) {
      assert.equal(m.statuses[i], "skipped", `line ${i}: the engine marks the budget skip as skipped`);
      assert.equal(m.pills[i], "Skipped", `line ${i}: a budget skip shows as Skipped`);
      assert.equal(id, undefined, `line ${i}: skipped line has no PayPal order`);
      for (const r of payReplies[i] ?? []) assert.equal(r.orderId ?? null, null, `line ${i}: no order id in the server's reply`);
      out.push(`${line.itemId} skipped for budget, no order`);
      continue;
    }
    if (m.statuses[i] === "declined") {
      if (id) {
        const order = await paypalOrder(id);
        const st = paymentStatus(order);
        // Never approved: PayPal reports an order carrying payment_source.paypal as
        // PAYER_ACTION_REQUIRED until the buyer approves; CREATED is the same state without one.
        assert.match(order.status, /^(CREATED|PAYER_ACTION_REQUIRED)$/, `line ${i}: order ${id} never approved (${order.status})`);
        assert.equal(st.capture, null, `line ${i}: no capture`);
        assert.equal(st.auth, null, `line ${i}: no authorization`);
        checkInvoice(order, i);
        out.push(`${line.itemId} declined, ${id} ${order.status}`);
      } else out.push(`${line.itemId} declined, no order`);
      continue;
    }
    if (m.statuses[i] === "no-deal") {
      assert.equal(id, undefined, `line ${i}: no deal, no PayPal order`);
      out.push(`${line.itemId} no deal, no order`);
      continue;
    }
    assert.ok(id, `line ${i} has a PayPal order`);
    const order = await paypalOrder(id);
    const st = paymentStatus(order);
    assert.equal(order.status, "COMPLETED", `line ${i}: PayPal order ${id} completed`);
    assert.equal(order.purchase_units[0].amount.value, line.deal.outcome.amountToPay.toFixed(2), `line ${i}: PayPal amount`);
    checkInvoice(order, i);
    if (getItem(line.itemId).paypalFlow === "capture_now") {
      assert.equal(st.capture, "COMPLETED", `line ${i}: capture completed`);
    } else if (m.statuses[i] === "captured") {
      assert.equal(st.auth, "CAPTURED", `line ${i}: hold captured`);
      assert.equal(st.capture, "COMPLETED", `line ${i}: capture on delivery completed`);
    } else {
      assert.equal(st.auth, "VOIDED", `line ${i}: hold voided`);
      assert.equal(st.capture, null, `line ${i}: nothing captured`);
    }
    if (st.capture === "COMPLETED") charged += Number(order.purchase_units[0].payments.captures[0].amount.value);
    out.push(`${line.itemId} ${id} ${st.auth ?? st.capture} ${order.purchase_units[0].invoice_id}`);
  }
  return { charged: Math.round(charged * 100) / 100, out };
}

/** The receipt matches PayPal and demo mode, and stays within your budget. */
async function checkReceipt(page, m, charged) {
  const receipt = await receiptPaid(page);
  assert.equal(receipt, charged, "receipt total equals what PayPal captured");
  assert.equal(receipt, m.paid, "receipt total equals the demo-mode total");
  assert.ok(charged <= RULES.budgetUsd, `PayPal captured $${charged}, within the $${RULES.budgetUsd} budget`);
  assert.match(await page.locator(".receipt").innerText(), new RegExp(`Paid \\$${m.paid} of \\$${RULES.budgetUsd}`), "receipt is measured against your budget");
  return receipt;
}

await scenario(`your rules with real PayPal: budget $${RULES.budgetUsd}, ask above $${RULES.askAboveUsd} on deal ${DEAL}`, async (ctx, s) => {
  const m = expectedMission(DEAL, RULES);
  assert.ok(m.run.lines.some((l) => l.deal.outcome.budgetSkip), "the engine skips at least one item for the budget");
  assert.ok(m.statuses.includes("captured"), "at least one line is paid in demo mode");

  const page = (s.page = await ctx.newPage());
  s.orders = trackOrders(page);
  const payReplies = trackPayReplies(page);
  await openWithRules(page);
  assert.match(await page.locator("main").innerText(), /PayPal AI Hackathon in 10 days/);
  assert.match(await page.locator(".goal").innerText(), new RegExp(`Budget \\$${RULES.budgetUsd}\\.`), "the mission quote shows your budget");

  const { windows, sheets } = await playLive(page, () => "approved");
  assert.equal(sheets, m.asked.length, "approval sheet shown for each ask-you line");
  assert.deepEqual(await page.locator(".list .pill").allTextContents(), m.pills, "final statuses match demo mode under your rules");
  const { charged, out } = await checkLines(m, s.orders, payReplies);
  const receipt = await checkReceipt(page, m, charged);
  return `deal ${DEAL}, ${windows} PayPal windows, ${sheets} asks, paid $${receipt}: ${out.join("; ")}`;
});

await scenario(`decline an ask-you line with real PayPal: never approved, never paid (deal ${DEAL}, your rules)`, async (ctx, s) => {
  const m = expectedMission(DEAL, RULES, true);
  const declined = Number(Object.keys(m.decisions).find((k) => m.decisions[k] === "declined"));
  assert.ok(Number.isInteger(declined), "this deal has an ask-you line to decline");
  assert.equal(m.statuses[declined], "declined", "demo mode shows the line declined");

  const page = (s.page = await ctx.newPage());
  s.orders = trackOrders(page);
  const payReplies = trackPayReplies(page);
  const declines = [];
  page.on("request", (r) => {
    if (!r.url().endsWith("/api/agent/decline")) return;
    try {
      declines.push(JSON.parse(r.postData() ?? "{}").line);
    } catch {
      // not JSON
    }
  });
  await openWithRules(page);
  const { windows, sheets } = await playLive(page, (n) => (n === 0 ? "declined" : "approved"));

  assert.equal(sheets, m.asked.length, "approval sheet shown for each ask-you line");
  assert.deepEqual(await page.locator(".list .pill").allTextContents(), m.pills, "final statuses match demo mode");
  assert.ok(declines.includes(declined), `line ${declined}: the decline was sent to the server`);
  const { charged, out } = await checkLines(m, s.orders, payReplies);
  const receipt = await checkReceipt(page, m, charged);
  return `${windows} PayPal windows, paid $${receipt}: ${out.join("; ")}`;
});

await browser.close();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
