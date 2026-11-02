// Shared helpers for the real PayPal sandbox browser tests. Fake money only.
// Credentials come from the environment and are never logged.
import { buildSingleRun } from "../../lib/timeline.ts";
import { getItem } from "../../src/engine/index.ts";

export const BASE_URL = process.env.BASE_URL ?? "http://localhost:3100";
const EMAIL = process.env.PAYPAL_SANDBOX_BUYER_EMAIL;
const PASSWORD = process.env.PAYPAL_SANDBOX_BUYER_PASSWORD;
const API = process.env.PAYPAL_API_BASE ?? "https://api-m.sandbox.paypal.com";

/** Exits with a skip note when no sandbox buyer login is set. */
export function requireBuyer() {
  if (!EMAIL || !PASSWORD) {
    console.log("skip - set PAYPAL_SANDBOX_BUYER_EMAIL and PAYPAL_SANDBOX_BUYER_PASSWORD to run the sandbox checks");
    process.exit(0);
  }
}

/** PayPal's record of an order, read with the app's own API keys. */
export async function paypalOrder(id) {
  const basic = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const tok = await fetch(`${API}/v1/oauth2/token`, { method: "POST", headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" }).then((r) => r.json());
  return fetch(`${API}/v2/checkout/orders/${id}`, { headers: { Authorization: `Bearer ${tok.access_token}` } }).then((r) => r.json());
}

/** A single-item table whose agreed price AgentGuard approves without asking, matching `want`. */
export function findTable(want) {
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

const PAY_BUTTON = "#payment-submit-btn, button:has-text('Complete Purchase'), button:has-text('Pay Now'), button:has-text('Continue to Review Order'), button:has-text('Agree & Continue'), button:has-text('Agree and Continue'), #consentButton, button:has-text('Save and Continue'), button:has-text('Continue')";

/** Waits for PayPal to load in the window (it may open blank first), then logs in if asked. */
export async function loginInPayPal(popup) {
  await popup.waitForURL(/paypal\.com/, { timeout: 60_000, waitUntil: "domcontentloaded" });
  await popup.locator(`#email, ${PAY_BUTTON}`).first().waitFor({ state: "visible", timeout: 45_000 });
  const email = popup.locator("#email");
  if (await email.isVisible().catch(() => false)) {
    await email.fill(EMAIL);
    const next = popup.locator("#btnNext");
    if (await next.isVisible().catch(() => false)) await next.click();
    await popup.locator("#password").fill(PASSWORD);
    await popup.locator("#btnLogin").click();
  }
}

/** Log in as the sandbox buyer and approve, in whatever order PayPal shows its screens. */
export async function approveInPayPal(popup) {
  await loginInPayPal(popup);
  const pay = popup.locator(PAY_BUTTON).first();
  await pay.waitFor({ state: "visible", timeout: 45_000 });
  await pay.click();
  await popup.waitForEvent("close", { timeout: 45_000 }).catch(() => undefined);
}

/** Log in as the sandbox buyer, then leave through PayPal's cancel link instead of paying. */
export async function cancelInPayPal(popup) {
  await loginInPayPal(popup);
  const cancel = popup.locator("#cancelLink, a:has-text('Cancel and return'), button:has-text('Cancel and return'), a:has-text('Cancel'), button:has-text('Cancel')").first();
  await cancel.waitFor({ state: "visible", timeout: 45_000 });
  await cancel.click();
  await popup.waitForEvent("close", { timeout: 45_000 }).catch(() => undefined);
}

/** Saves what a PayPal window showed, for debugging selectors. Never logs credentials. */
export async function savePopup(popup, name) {
  if (!popup || popup.isClosed()) return;
  await popup.screenshot({ path: `/tmp/paypal-popup-${name}.png`, fullPage: true }).catch(() => undefined);
  await import("node:fs").then((fs) => popup.content().then((html) => fs.writeFileSync(`/tmp/paypal-popup-${name}.html`, html))).catch(() => undefined);
  console.log(`  popup url: ${popup.url().split("?")[0]}`);
}
