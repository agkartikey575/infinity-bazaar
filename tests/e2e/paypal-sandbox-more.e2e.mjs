// More real PayPal sandbox checks in a real browser: cancelling in PayPal, a full
// mission paid through PayPal, and paying from a connected (vaulted) wallet.
// Fake money only. Same setup as paypal-sandbox.e2e.mjs:
//   BASE_URL=https://infinity-bazaar.vercel.app \
//   PAYPAL_SANDBOX_BUYER_EMAIL=... PAYPAL_SANDBOX_BUYER_PASSWORD=... \
//   PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... \
//   node tests/e2e/paypal-sandbox-more.e2e.mjs
import { createRequire } from "node:module";
import assert from "node:assert/strict";

import { buildMissionRun, buildSteps, deriveView } from "../../lib/timeline.ts";
import { getItem } from "../../src/engine/index.ts";
import { approveInPayPal, BASE_URL, cancelInPayPal, findTable, panelReport, paymentStatus, paypalOrder, requireBuyer, savePopup, trackOrders } from "./paypal-helpers.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
requireBuyer();

const MISSION = "hackathon-10-days";
const LABEL = { captured: "Paid", declined: "Declined", voided: "Hold released", blocked: "Blocked", "no-deal": "Walked away" };

/** Demo-mode outcome of a mission table when every ask is approved. */
function expectedMission(seed) {
  const run = buildMissionRun(MISSION, seed);
  const decisions = {};
  for (;;) {
    const r = buildSteps(run, decisions);
    if (r.waitingFor === null) {
      const v = deriveView(run, r.steps, r.steps.length);
      return { run, pills: v.statuses.map((x) => LABEL[x] ?? x), paid: v.capturedUsd, asked: Object.keys(decisions).map(Number) };
    }
    decisions[r.waitingFor] = "approved";
  }
}

/** A mission table with at least one "ask you" line, every line paid or released; prefers one with both. */
function findMissionTable() {
  let fallback = null;
  for (let seed = 1; seed < 400; seed++) {
    const e = expectedMission(seed);
    if (!e.asked.length || !e.pills.every((p) => p === "Paid" || p === "Hold released")) continue;
    if (e.pills.includes("Hold released") && e.pills.includes("Paid")) return { seed, ...e };
    fallback ??= { seed, ...e };
  }
  if (!fallback) throw new Error("no mission table with an ask-you line");
  return fallback;
}

async function openRoom(ctx) {
  const page = await ctx.newPage();
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  return page;
}

async function pickItem(page, t) {
  await page.locator("#selection").selectOption(`item:${t.item}`);
  await page.locator("#seed").fill(String(t.seed));
  await page.locator("#seed").press("Enter");
  await page.selectOption("#speed", "4");
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
    const slug = name.split(" ")[0].toLowerCase();
    if (state.page) await state.page.screenshot({ path: `/tmp/paypal-more-${slug}.png`, fullPage: true }).catch(() => undefined);
    const report = state.page ? await panelReport(state.page) : "";
    console.log(`not ok - ${name}\n  ${String(e.message).split("\n").join("\n  ")}\n  orders: ${JSON.stringify(state.orders)}\n  ${report}`);
  } finally {
    await ctx.close();
  }
}

// 1. Cancel in PayPal: the line is declined and PayPal never completes the order.
await scenario("cancel in PayPal: declined, nothing charged", async (ctx, s) => {
  const t = findTable("capture");
  const page = (s.page = await openRoom(ctx));
  s.orders = trackOrders(page);
  await page.getByLabel(/PayPal (\(sandbox\)|sandbox)/i).check();
  await pickItem(page, t);
  const payBtn = page.getByRole("button", { name: "Pay with PayPal" });
  await payBtn.waitFor({ timeout: 120_000 });
  const [popup] = await Promise.all([page.waitForEvent("popup"), payBtn.click()]);
  try {
    await cancelInPayPal(popup);
  } catch (e) {
    await savePopup(popup, "cancel");
    throw e;
  }
  await page.locator(".list .pill", { hasText: "Declined" }).first().waitFor({ timeout: 60_000 });
  assert.equal((await page.locator(".list .row b").allTextContents())[0], "—", "declined line shows no amount");
  await page.locator("header button.primary", { hasText: /Replay/ }).waitFor({ timeout: 60_000 });
  assert.match(await page.locator(".receipt-head").innerText(), /Paid \$0 /, "receipt shows nothing paid");
  const id = s.orders[0];
  assert.ok(id, "an order was created before the cancel");
  const order = await paypalOrder(id);
  const st = paymentStatus(order);
  assert.notEqual(order.status, "COMPLETED", "PayPal order is not completed");
  assert.equal(st.capture, null, "no capture on PayPal");
  assert.equal(st.auth, null, "no authorization on PayPal");
  return `${t.item}, table ${t.seed}, order ${id}, ${order.status}`;
});

// 2. A full mission with real PayPal: approve the ask-you line in the sheet, then each PayPal window.
await scenario("mission with real PayPal: every line settles as in demo mode", async (ctx, s) => {
  const m = findMissionTable();
  const page = (s.page = await openRoom(ctx));
  s.orders = trackOrders(page);
  await page.locator("#selection").selectOption(`mission:${MISSION}`);
  await page.getByLabel(/PayPal (\(sandbox\)|sandbox)/i).check();
  await page.locator("#seed").fill(String(m.seed));
  await page.locator("#seed").press("Enter");
  await page.selectOption("#speed", "4");
  assert.match(await page.locator("main").innerText(), /PayPal AI Hackathon in 10 days/);

  let windows = 0;
  let sheets = 0;
  const deadline = Date.now() + 8 * 60_000;
  for (;;) {
    assert.ok(Date.now() < deadline, "mission did not finish in time");
    if (/Replay/.test(await page.locator("header button.primary").innerText())) break;
    const sheetBtn = page.getByRole("dialog").getByRole("button", { name: /^Approve/ });
    const payBtn = page.getByRole("button", { name: "Pay with PayPal" });
    let opener = null;
    if (await sheetBtn.isVisible().catch(() => false)) {
      opener = sheetBtn;
      sheets++;
    } else if (await payBtn.isVisible().catch(() => false)) opener = payBtn;
    else if (await page.locator(".paypal .row-bad button", { hasText: "Retry" }).isVisible().catch(() => false)) throw new Error("the app shows a payment error");
    else if (await page.locator(".paypal .row-ask button", { hasText: "Approve" }).isVisible().catch(() => false)) throw new Error("the server's AgentGuard asked for an OK that demo mode did not");
    if (!opener) {
      await page.waitForTimeout(500);
      continue;
    }
    const [popup] = await Promise.all([page.waitForEvent("popup", { timeout: 30_000 }), opener.click()]);
    windows++;
    try {
      await approveInPayPal(popup);
    } catch (e) {
      await savePopup(popup, `mission-${windows}`);
      throw e;
    }
  }

  assert.equal(sheets, m.asked.length, "approval sheet shown for each ask-you line");
  assert.deepEqual(await page.locator(".list .pill").allTextContents(), m.pills, "final statuses match demo mode");
  const out = [];
  let charged = 0;
  for (const [i, line] of m.run.lines.entries()) {
    const id = s.orders[i];
    assert.ok(id, `line ${i} has a PayPal order`);
    const order = await paypalOrder(id);
    const st = paymentStatus(order);
    const amount = line.deal.outcome.amountToPay;
    assert.equal(order.status, "COMPLETED", `line ${i}: PayPal order ${id} completed`);
    assert.equal(order.purchase_units[0].amount.value, amount.toFixed(2), `line ${i}: PayPal amount`);
    if (getItem(line.itemId).paypalFlow === "capture_now") {
      assert.equal(st.capture, "COMPLETED", `line ${i}: capture completed`);
    } else if (m.pills[i] === "Paid") {
      assert.equal(st.auth, "CAPTURED", `line ${i}: hold captured`);
      assert.equal(st.capture, "COMPLETED", `line ${i}: capture on delivery completed`);
    } else {
      assert.equal(st.auth, "VOIDED", `line ${i}: hold voided`);
      assert.equal(st.capture, null, `line ${i}: nothing captured`);
    }
    if (st.capture === "COMPLETED") charged += Number(order.purchase_units[0].payments.captures[0].amount.value);
    out.push(`${line.itemId} ${id} ${st.auth ?? st.capture}`);
  }
  const receipt = Number((await page.locator(".receipt-head b").innerText()).match(/Paid \$([\d.]+)/)?.[1]);
  assert.equal(receipt, Math.round(charged * 100) / 100, "receipt total equals what PayPal captured");
  assert.equal(receipt, m.paid, "receipt total equals the demo-mode total");
  return `table ${m.seed}, ${windows} PayPal windows, paid $${receipt}: ${out.join("; ")}`;
});

// 3. Connected wallet: approve once in PayPal, then an approved item pays with no PayPal window.
await scenario("connected wallet: approved item pays with no PayPal window", async (ctx, s) => {
  const t = findTable("capture");
  const page = (s.page = await openRoom(ctx));
  s.orders = trackOrders(page);
  const pays = [];
  page.on("request", (r) => r.url().endsWith("/api/agent/pay") && pays.push(r.url()));
  await page.getByLabel(/PayPal (\(sandbox\)|sandbox)/i).check();
  // Switching on restarts the default mission; pause it so nothing is paid before the wallet is connected.
  await page.locator("header button.primary", { hasText: "Pause" }).click();
  assert.equal(pays.length, 0, "nothing paid before connecting");
  const connect = page.getByRole("button", { name: "Connect PayPal wallet" });
  const [popup] = await Promise.all([page.waitForEvent("popup"), connect.click()]);
  try {
    await approveInPayPal(popup);
  } catch (e) {
    await savePopup(popup, "wallet");
    throw e;
  }
  await page.locator(".pill", { hasText: "Wallet connected" }).waitFor({ timeout: 60_000 }).catch(async () => {
    throw new Error(`wallet not connected${(await page.locator(".paypal-mode .note").count()) ? `: ${await page.locator(".paypal-mode .note").innerText()}` : ""}`);
  });

  let windows = 0;
  page.on("popup", () => windows++);
  await pickItem(page, t);
  await page.locator(".list .pill", { hasText: "Paid" }).first().waitFor({ timeout: 120_000 });
  assert.equal(windows, 0, "no PayPal window opened for the payment");
  await page.getByLabel("Show PayPal details").check();
  assert.match(await page.locator(".checkout").innerText(), /vaulted wallet/, "paid from the connected wallet");
  const id = s.orders[0];
  assert.ok(id, "order id recorded");
  const order = await paypalOrder(id);
  const st = paymentStatus(order);
  assert.equal(order.status, "COMPLETED", "PayPal order completed");
  assert.equal(st.capture, "COMPLETED", "capture completed");
  assert.equal(order.purchase_units[0].amount.value, t.amount.toFixed(2), "PayPal charged the agreed amount");
  return `${t.item}, table ${t.seed}, $${t.amount}, order ${id}, ${st.capture}`;
});

await browser.close();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
