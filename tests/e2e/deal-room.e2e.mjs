// End-to-end check of the deal room in a real headless browser.
// Start the app first:  npx next build && npx next start -p 3100
// Then run:             node tests/e2e/deal-room.e2e.mjs   (BASE_URL overrides the address)
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const BASE_URL = process.env.BASE_URL ?? "http://localhost:3100";

const browser = await chromium.launch();
let failures = 0;

async function check(name, viewport, fn) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const problems = [];
  page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(e.message));
  try {
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await fn(page);
    assert.deepEqual(problems, [], "console errors or warnings");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.equal(overflow, 0, "horizontal scroll");
    console.log(`ok - ${name}`);
  } catch (e) {
    failures++;
    console.log(`not ok - ${name}\n  ${String(e.message).split("\n").join("\n  ")}`);
  } finally {
    await ctx.close();
  }
}

const btn = (page, name) => page.getByRole("button", { name, exact: typeof name === "string" });
const pills = (page) => page.locator(".list .pill").allTextContents();
const skip = async (page) => {
  await btn(page, /Skip/).click();
  await page.waitForTimeout(150);
};
/** "New table" picks Math.random() * 1e6; pin it to replay a known table. */
async function newTable(page, seed) {
  await page.evaluate((s) => {
    window.__random = Math.random;
    Math.random = () => (s + 0.5) / 1e6;
  }, seed);
  await btn(page, /New table/).click();
  await page.evaluate(() => (Math.random = window.__random));
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  const w = viewport.width;

  await check(`${w}px: default mission plays to the end`, viewport, async (page) => {
    assert.deepEqual(await pills(page), ["Waiting", "Waiting", "Waiting"]);
    await page.selectOption("#speed", "4");
    await btn(page, /Play/).click();
    await page.waitForSelector(".booth", { timeout: 5000 });
    await skip(page);
    assert.match(await page.locator("button.primary").first().textContent(), /Replay/);
    assert.equal((await pills(page)).filter((p) => /Paid/.test(p)).length, 3);
    assert.equal(await page.locator(".floor").count(), 3, "hidden floors revealed");
    assert.match(await page.locator(".checkout").innerText(), /POST \/v2\/checkout\/orders/);
    assert.match(await page.locator(".bnums").innerText(), /Spent \$177/);
  });

  await check(`${w}px: approval, approve and decline`, viewport, async (page) => {
    await newTable(page, 1);
    await skip(page);
    assert.equal(await page.locator(".approve").count(), 1, "approval box shown");
    assert.match(await page.locator(".bnums").innerText(), /Waiting \$106/);
    await btn(page, "Approve").click();
    await skip(page);
    assert.equal((await pills(page))[1], "Paid, held until delivery");
    assert.match(await page.locator(".bnums").innerText(), /Spent \$186/);

    await newTable(page, 7);
    await skip(page);
    await btn(page, "Decline").click();
    await skip(page);
    assert.equal((await pills(page))[1], "Declined");
    assert.match(await page.locator(".bnums").innerText(), /Spent \$79/);
    assert.doesNotMatch(await page.locator(".bnums").innerText(), /Waiting/);
  });

  await check(`${w}px: rogue agent is blocked before PayPal`, viewport, async (page) => {
    await btn(page, /rogue/i).click();
    await skip(page);
    assert.deepEqual(await pills(page), ["Blocked"]);
    const checkout = await page.locator(".checkout").innerText();
    assert.match(checkout, /BLOCKED/);
    assert.doesNotMatch(checkout, /POST /);
    assert.match(await page.locator(".bnums").innerText(), /Spent \$0/);
  });

  await check(`${w}px: single items play without broken text`, viewport, async (page) => {
    for (const id of ["stickers", "energy-drinks", "portable-monitor", "logo-designer", "ai-credits", "font-license"]) {
      await page.selectOption("#selection", `item:${id}`);
      for (let i = 0; i < 3 && !(await btn(page, /Skip/).isDisabled()); i++) {
        await skip(page);
        if (await page.locator(".approve").count()) await btn(page, "Approve").click();
      }
      const text = await page.locator(".room").innerText();
      assert.doesNotMatch(text, /undefined|NaN|\$null/, id);
      assert.match(await page.locator("button.primary").first().textContent(), /Replay/, id);
    }
  });
}

await browser.close();
console.log(failures ? `${failures} failed` : "all passed");
process.exitCode = failures ? 1 : 0;
