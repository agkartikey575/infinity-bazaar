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

import { approveInPayPal, BASE_URL, findTable, paypalOrder, requireBuyer } from "./paypal-helpers.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
requireBuyer();

const browser = await chromium.launch();
let failures = 0;

async function scenario(name, want, expectPill, expectPayPal) {
  const t = findTable(want);
  let orderId;
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
    orderId = panel.match(/order ([A-Z0-9]{17})/)?.[1];
    assert.ok(orderId, "order id shown in the PayPal details");
    const order = await paypalOrder(orderId);
    const payments = order.purchase_units?.[0]?.payments ?? {};
    // A held payment reports its authorization (CAPTURED or VOIDED); an immediate one reports its capture.
    const status = payments.authorizations?.[0]?.status ?? payments.captures?.[0]?.status;
    if (payments.authorizations?.[0]?.status === "CAPTURED") assert.equal(payments.captures?.[0]?.status, "COMPLETED", "capture on delivery completed");
    assert.equal(order.status, "COMPLETED", "PayPal order completed");
    assert.match(status, expectPayPal, `PayPal payment status (${status})`);
    assert.equal(order.purchase_units[0].amount.value, t.amount.toFixed(2), "PayPal charged the agreed amount");
    console.log(`ok - ${name} (${t.item}, table ${t.seed}, $${t.amount}, order ${orderId}, ${status})`);
  } catch (e) {
    failures++;
    await page.screenshot({ path: `/tmp/paypal-${want}.png`, fullPage: true }).catch(() => undefined);
    console.log(`not ok - ${name}${orderId ? ` (order ${orderId})` : ""}\n  ${String(e.message).split("\n").join("\n  ")}`);
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
