// End-to-end check of the deal room in a real headless browser.
// Start the app first:  npx next build && npx next start -p 3100
// Then run:             node tests/e2e/deal-room.e2e.mjs   (BASE_URL overrides the address)
import { createRequire } from "node:module";
import assert from "node:assert/strict";

import { buildMissionRun, buildSteps, deriveView } from "../../lib/timeline.ts";

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
const amounts = (page) => page.locator(".list .row b").allTextContents();
const bnums = (page) => page.locator(".bnums").innerText();
const skip = async (page) => {
  await btn(page, /Skip/).click();
  await page.waitForTimeout(250);
};
/** Picks a table by typing in the "Table #" input and pressing Enter. */
async function table(page, seed) {
  await page.locator("#seed").fill(String(seed));
  await page.locator("#seed").press("Enter");
  await page.waitForTimeout(150);
}
/** Plays to the end, answering every approval the same way. */
async function playToEnd(page, answer) {
  for (let i = 0; i < 12; i++) {
    if (await page.getByRole("dialog").count()) {
      await btn(page, answer === "approved" ? "Approve in PayPal" : "Decline").click();
      await page.waitForTimeout(150);
    } else if (await btn(page, /Skip/).isDisabled()) break;
    else await skip(page);
  }
}
/** The approval sheet is visible, focused on Approve, and both buttons are on screen. */
async function checkSheet(page, viewport) {
  const sheet = page.getByRole("dialog");
  assert.equal(await sheet.count(), 1, "approval sheet shown");
  assert.match(await page.evaluate(() => document.activeElement?.textContent ?? ""), /Approve/, "Approve has focus");
  for (const name of ["Approve in PayPal", "Decline"]) {
    const box = await btn(page, name).boundingBox();
    assert.ok(box && box.y >= 0 && box.y + box.height <= viewport.height, `${name} is inside the viewport`);
  }
  assert.ok(await page.locator("header button.primary").isDisabled(), "Play is disabled while waiting");
}

// Expected outcomes come from the engine itself, so this test follows engine changes.
const LABEL = { captured: "Paid", declined: "Declined", voided: "Hold released", blocked: "Blocked", "no-deal": "Walked away" };
function expected(seed, answer) {
  const run = buildMissionRun("hackathon-10-days", seed);
  const decisions = {};
  for (;;) {
    const r = buildSteps(run, decisions);
    if (r.waitingFor === null) {
      const v = deriveView(run, r.steps, r.steps.length);
      return { run, pills: v.statuses.map((x) => LABEL[x] ?? x), paid: v.capturedUsd, asked: Object.keys(decisions).map(Number) };
    }
    decisions[r.waitingFor] = answer;
  }
}
const firstSeed = (pred) => Array.from({ length: 400 }, (_, i) => i + 1).find(pred);
const askSeed = firstSeed((s) => buildSteps(buildMissionRun("hackathon-10-days", s), {}).waitingFor !== null);
const voidSeed = firstSeed((s) => expected(s, "approved").pills.includes("Hold released"));

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 640 }]) {
  const w = viewport.width;

  await check(`${w}px: default mission plays to the end with a receipt`, viewport, async (page) => {
    const exp = expected(42, "approved");
    assert.deepEqual(await pills(page), exp.pills.map(() => "Waiting"));
    await page.selectOption("#speed", "4");
    await btn(page, "Play").click();
    await page.waitForSelector(".booth .say p:not(.quiet)", { timeout: 5000 });
    await page.waitForTimeout(3000);
    await playToEnd(page, "approved");
    await page.waitForTimeout(800);
    assert.match(await page.locator("header button.primary").textContent(), /Replay/);
    assert.deepEqual(await pills(page), exp.pills);
    assert.equal(await page.locator(".floor").count(), 3, "hidden floors revealed");
    assert.doesNotMatch(await page.locator(".checkout").innerText(), /POST \/v2\//, "API details hidden by default");
    await page.getByLabel("Show PayPal details").check();
    assert.match(await page.locator(".checkout").innerText(), /POST \/v2\//);
    assert.match(await bnums(page), new RegExp(`Paid \\$${exp.paid}\\b`));
    assert.equal(await page.locator(".receipt tbody tr").count(), exp.pills.length, "receipt lists every item");
    assert.equal(await page.locator(".booth").count(), 3, "three sellers in the arena");
    await page.locator(".transcript summary").click();
    await page.waitForTimeout(300);
    assert.ok((await page.locator(".transcript .msg").count()) > 3, "transcript keeps the whole conversation");
    const gap = await page.$eval(".transcript .log", (e) => e.scrollHeight - e.scrollTop - e.clientHeight);
    assert.ok(gap <= 2, `transcript scrolled to the newest message: ${gap}`);
  });

  await check(`${w}px: approval sheet, approve (table ${askSeed})`, viewport, async (page) => {
    const exp = expected(askSeed, "approved");
    const first = exp.run.lines[exp.asked[0]].deal.outcome.amountToPay;
    await table(page, askSeed);
    await skip(page);
    await checkSheet(page, viewport);
    assert.match(await page.getByRole("dialog").innerText(), new RegExp(`Pay \\$${first}\\.00`));
    assert.match(await bnums(page), new RegExp(`Waiting \\$${first}\\b`));
    await playToEnd(page, "approved");
    assert.deepEqual(await pills(page), exp.pills);
    assert.match(await bnums(page), new RegExp(`Paid \\$${exp.paid}\\b`));
  });

  await check(`${w}px: approval sheet, decline (table ${askSeed})`, viewport, async (page) => {
    const exp = expected(askSeed, "declined");
    await table(page, askSeed);
    await skip(page);
    await checkSheet(page, viewport);
    await playToEnd(page, "declined");
    assert.deepEqual(await pills(page), exp.pills);
    for (const i of exp.asked) assert.equal((await amounts(page))[i], "—", "declined line shows no amount");
    assert.match(await bnums(page), new RegExp(`Paid \\$${exp.paid}\\b`));
    assert.doesNotMatch(await bnums(page), /Waiting/);
  });

  await check(`${w}px: Escape declines in the approval sheet`, viewport, async (page) => {
    await table(page, askSeed);
    await skip(page);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    assert.equal(await page.getByRole("dialog").count(), 0, "sheet closed");
  });

  await check(`${w}px: failed delivery voids the hold (table ${voidSeed})`, viewport, async (page) => {
    const exp = expected(voidSeed, "approved");
    await table(page, voidSeed);
    await playToEnd(page, "approved");
    assert.deepEqual(await pills(page), exp.pills);
    const i = exp.pills.indexOf("Hold released");
    assert.equal((await amounts(page))[i], "—");
    assert.match(await page.locator(".receipt").innerText(), /Hold released/);
    assert.match(await bnums(page), new RegExp(`Paid \\$${exp.paid}\\b`));
  });

  await check(`${w}px: rogue agent is blocked before PayPal, New table stays rogue`, viewport, async (page) => {
    await btn(page, /rogue/i).click();
    await skip(page);
    assert.deepEqual(await pills(page), ["Blocked"]);
    assert.equal((await amounts(page))[0], "—");
    assert.equal(await page.locator(".stamp").count(), 1, "blocked stamp");
    assert.match(await page.locator(".caster").innerText(), /[Bb]locked/);
    // AgentGuard's verdict shows in the gate; the Payment panel shows that nothing reached PayPal.
    assert.match(await page.locator(".gate").innerText(), /Blocked because/);
    assert.match(await page.locator(".gate .lamp.on").innerText(), /Block/, "gate shows the block state");
    assert.doesNotMatch(await page.locator(".checkout").innerText(), /POST |PayPal order|Paid \$/);
    assert.match(await bnums(page), /Paid \$0/);
    await btn(page, /New table/).click();
    await skip(page);
    assert.deepEqual(await pills(page), ["Blocked"], "New table keeps rogue mode");
  });

  await check(`${w}px: single items play without broken text`, viewport, async (page) => {
    for (const id of ["stickers", "energy-drinks", "portable-monitor", "logo-designer", "video-editor", "ai-credits", "font-license", "hosting-starter"]) {
      await page.selectOption("#selection", `item:${id}`);
      await playToEnd(page, "approved");
      const text = await page.locator(".room").innerText();
      assert.doesNotMatch(text, /undefined|NaN|\$null|\{\w+\}/, id);
      assert.match(await page.locator("header button.primary").textContent(), /Replay/, id);
      const [pill] = await pills(page);
      if (!/^Paid$/.test(pill)) assert.equal((await amounts(page))[0], "—", `${id}: no amount on ${pill}`);
    }
  });
}

await check("pause stops playback", { width: 1440, height: 900 }, async (page) => {
  await btn(page, "Play").click();
  await page.waitForTimeout(2000);
  await btn(page, "Pause").click();
  const n = await page.locator(".msg").count();
  await page.waitForTimeout(2000);
  assert.equal(await page.locator(".msg").count(), n);
});

await check("dark mode renders", { width: 390, height: 844 }, async (page) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await skip(page);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert.notEqual(bg, "rgb(255, 255, 255)");
});

await browser.close();
console.log(failures ? `${failures} failed` : "all passed");
process.exitCode = failures ? 1 : 0;
