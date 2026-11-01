// Real PayPal sandbox, end to end, in a real browser: the deal room pays through
// PayPal, a sandbox buyer approves in the PayPal window, and PayPal's own records
// are checked afterwards. Fake money only.
//
// Needs a server with PayPal sandbox keys, and a sandbox Personal (buyer) login:
//   BASE_URL=https://infinity-bazaar.vercel.app \
//   PAYPAL_SANDBOX_BUYER_EMAIL=... PAYPAL_SANDBOX_BUYER_PASSWORD=... \
//   PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... \
//   node tests/e2e/paypal-sandbox.e2e.mjs
import { createRequire } from "node:module";
import assert from "node:assert/strict";

import { buildSingleRun } from "../../lib/timeline.ts";
import { getItem } from "../../src/engine/index.ts";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3100";
const EMAIL = process.env.PAYPAL_SANDBOX_BUYER_EMAIL;
const PASSWORD = process.env.PAYPAL_SANDBOX_BUYER_PASSWORD;
const API = process.env.PAYPAL_API_BASE ?? "https://api-m.sandbox.paypal.com";
if (!EMAIL || !PASSWORD) {
  console.log("skip - set PAYPAL_SANDBOX_BUYER_EMAIL and PAYPAL_SANDBOX_BUYER_PASSWORD to run the sandbox checks");
  process.exit(0);
}

/** PayPal's record of an order, read with the app's own API keys. */
async function paypalOrder(id) {
  const basic = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const tok = await fetch(`${API}/v1/oauth2/token`, { method: "POST", headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" }).then((r) => r.json());
  return fetch(`${API}/v2/checkout/orders/${id}`, { headers: { Authorization: `Bearer ${tok.access_token}` } }).then((r) => r.json());
}

/** A single-item table whose agreed price AgentGuard approves without asking, matching `want`. */
function findTable(want) {
  for (const item of ["font-license", "icon-set", "ui-template", "usb-mic", "usb-c-hub", "mic-arm", "pizza", "stickers", "webcam"]) {
    let flow;
    try {
      flow = getItem(item).paypalFlow;
    } catch {
      continue;
    }
    for (let seed = 1; seed < 400; seed++) {
      const run = buildSingleRun(item, seed, false);
      const o = run.lines[0].deal.outcome;
      if (o.status !== "deal" || o.amountToPay > run.askAboveUsd || o.surpriseFee || o.futureFee) continue;
      if (want === "capture" && flow === "capture_now") return { item, seed, amount: o.amountToPay };
      if (want === "delivered" && flow !== "capture_now" && o.afterPayment === null) return { item, seed, amount: o.amountToPay };
      if (want === "failed" && flow !== "capture_now" && o.afterPayment !== null) return { item, seed, amount: o.amountToPay };
    }
  }
  throw new Error(`no table for ${want}`);
}

/** Log in as the sandbox buyer and approve, in whatever order PayPal shows its screens. */
async function approveInPayPal(popup) {
  await popup.waitForLoadState("domcontentloaded");
  const email = popup.locator("#email");
  if (await email.isVisible({ timeout: 20_000 }).catch(() => false)) {
    await email.fill(EMAIL);
    const next = popup.locator("#btnNext");
    if (await next.isVisible().catch(() => false)) await next.click();
    await popup.locator("#password").fill(PASSWORD);
    await popup.locator("#btnLogin").click();
  }
  const pay = popup.locator("#payment-submit-btn, button:has-text('Complete Purchase'), button:has-text('Pay Now'), button:has-text('Continue to Review Order'), button:has-text('Agree & Continue'), button:has-text('Continue')").first();
  await pay.waitFor({ state: "visible", timeout: 45_000 });
  await pay.click();
  await popup.waitForEvent("close", { timeout: 45_000 }).catch(() => undefined);
}

const browser = await chromium.launch();
let failures = 0;

async function scenario(name, want, expectPill, expectPayPal) {
  const t = findTable(want);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  try {
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await page.getByLabel(/PayPal (\(sandbox\)|sandbox)/i).check();
    await page.locator("#selection").selectOption(`item:${t.item}`);
    await page.locator("#seed").fill(String(t.seed));
    await page.locator("#seed").press("Enter");
    await page.selectOption("#speed", "4");
    const payBtn = page.getByRole("button", { name: "Pay with PayPal" });
    await payBtn.waitFor({ timeout: 120_000 });
    const [popup] = await Promise.all([page.waitForEvent("popup"), payBtn.click()]);
    try {
      await approveInPayPal(popup);
    } catch (e) {
      // Keep what PayPal showed, for debugging selectors. Never logs credentials.
      if (!popup.isClosed()) {
        await popup.screenshot({ path: `/tmp/paypal-popup-${want}.png`, fullPage: true }).catch(() => undefined);
        await import("node:fs").then((fs) => popup.content().then((html) => fs.writeFileSync(`/tmp/paypal-popup-${want}.html`, html))).catch(() => undefined);
        console.log(`  popup url: ${popup.url().split("?")[0]}`);
      }
      throw e;
    }
    await page.locator(".list .pill", { hasText: expectPill }).first().waitFor({ timeout: 120_000 });

    await page.getByLabel("Show PayPal details").check();
    const panel = await page.locator(".checkout").innerText();
    const orderId = panel.match(/order ([A-Z0-9]{17})/)?.[1];
    assert.ok(orderId, "order id shown in the PayPal details");
    const order = await paypalOrder(orderId);
    const payments = order.purchase_units?.[0]?.payments ?? {};
    const status = payments.captures?.[0]?.status ?? payments.authorizations?.[0]?.status;
    assert.equal(order.status, "COMPLETED", "PayPal order completed");
    assert.match(status, expectPayPal, `PayPal payment status (${status})`);
    assert.equal(order.purchase_units[0].amount.value, t.amount.toFixed(2), "PayPal charged the agreed amount");
    console.log(`ok - ${name} (${t.item}, table ${t.seed}, $${t.amount}, order ${orderId}, ${status})`);
  } catch (e) {
    failures++;
    await page.screenshot({ path: `/tmp/paypal-${want}.png`, fullPage: true }).catch(() => undefined);
    console.log(`not ok - ${name}\n  ${String(e.message).split("\n").join("\n  ")}`);
  } finally {
    await ctx.close();
  }
}

await scenario("digital item: buyer approves, PayPal captures now", "capture", "Paid", /^COMPLETED$/);
await scenario("shipped item delivered: hold, then captured on delivery", "delivered", "Paid", /^CAPTURED$/);
await scenario("shipped item not delivered: hold released, nothing charged", "failed", "Hold released", /^VOIDED$/);

await browser.close();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
