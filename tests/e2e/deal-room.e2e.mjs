// End-to-end check of the deal room in a real headless browser.
// Start the app first:  npx next build && npx next start -p 3100
// Then run:             node tests/e2e/deal-room.e2e.mjs   (BASE_URL overrides the address)
import { createRequire } from "node:module";
import assert from "node:assert/strict";

import { buildMissionRun, buildSingleRun, buildSteps, deriveView } from "../../lib/timeline.ts";

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
/** Picks a deal by typing in the "Deal #" input and pressing Enter. */
async function table(page, seed) {
  await page.locator("#seed").fill(String(seed));
  await page.locator("#seed").press("Enter");
  await page.waitForTimeout(150);
}
/** Plays to the end, answering every approval the same way. */
async function playToEnd(page, answer) {
  for (let i = 0; i < 12; i++) {
    if (await page.getByRole("dialog").count()) {
      await btn(page, answer === "approved" ? "Approve" : "Decline").click();
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
  for (const name of ["Approve", "Decline"]) {
    const box = await btn(page, name).boundingBox();
    assert.ok(box && box.y >= 0 && box.y + box.height <= viewport.height, `${name} is inside the viewport`);
  }
  assert.ok(await page.locator("header button.primary").isDisabled(), "Play is disabled while waiting");
}

// Expected outcomes come from the engine itself, so this test follows engine changes.
const LABEL = { captured: "Paid", declined: "Declined", voided: "Hold released", blocked: "Blocked", "no-deal": "Walked away", skipped: "Skipped" };
function expected(seed, answer, rules) {
  const run = buildMissionRun("hackathon-10-days", seed, rules);
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
    await page.waitForSelector(".booth .msg", { state: "attached", timeout: 8000 });
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
    assert.equal(await page.locator(".booth").count(), 3, "three booths in the arena");
    const gaps = await page.$$eval(".booth .log", (els) => els.filter((e) => e.offsetParent).map((e) => e.scrollHeight - e.scrollTop - e.clientHeight));
    assert.ok(gaps.length >= 1, "at least one booth is visible");
    assert.ok(gaps.every((g) => g <= 2), `booth logs scrolled to the newest message: ${gaps}`);
  });

  await check(`${w}px: approval sheet, approve (table ${askSeed})`, viewport, async (page) => {
    const exp = expected(askSeed, "approved");
    const first = exp.run.lines[exp.asked[0]].deal.outcome.amountToPay;
    await table(page, askSeed);
    await skip(page);
    await checkSheet(page, viewport);
    assert.match(await page.getByRole("dialog").innerText(), new RegExp(`Pay \\$${(Number.isInteger(first) ? String(first) : first.toFixed(2)).replace(".", "\\.")}\\b`));
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

  await check(`${w}px: rogue agent is blocked before PayPal, New deal stays rogue`, viewport, async (page) => {
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
    await btn(page, /New deal/).click();
    await skip(page);
    assert.deepEqual(await pills(page), ["Blocked"], "New deal keeps rogue mode");
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

  await check(`${w}px: your rules (budget $120, ask above $40) on deal 42 decide what's paid`, viewport, async (page) => {
    const rules = { budgetUsd: 120, askAboveUsd: 40 };
    const exp = expected(42, "approved", rules);
    assert.notDeepEqual(exp.pills, expected(42, "approved").pills, "these rules change the outcome");
    assert.equal(await page.locator("#budget").inputValue(), "300", "prefilled with the mission's budget");
    assert.equal(await page.locator("#ask").inputValue(), "100", "prefilled with the mission's approval limit");
    await page.selectOption("#speed", "4");
    await page.locator("#budget").fill("120");
    await page.locator("#ask").fill("40");
    await page.locator("#ask").press("Enter");
    await page.waitForTimeout(200);
    assert.match(await page.locator(".goal").innerText(), /Budget \$120\./, "the mission quote shows your budget");
    assert.match(await bnums(page), /Budget \$120\b/);
    assert.match(await page.locator(".pc.limit").innerText(), /of \$120 budget/);
    assert.match(await page.locator(".bask").getAttribute("title"), /\$40/);
    assert.match(await page.locator("#rules-preview").innerText(), /With \$120, your agent usually buys 2 of 3 items and skips the rest to stay in budget · anything over \$40 asks you first/);
    assert.equal(new URL(page.url()).search, "?deal=42&budget=120&ask=40", "the link carries the deal and your rules");
    // The engine skips an item to stay within $120; the screen says so in plain words.
    const skipped = exp.run.lines.findIndex((l) => l.deal.outcome.budgetSkip);
    assert.ok(skipped >= 0, "deal 42 at $120 skips an item for the budget");
    assert.equal(exp.pills[skipped], "Skipped");
    await playToEnd(page, "approved");
    assert.deepEqual(await pills(page), exp.pills, "statuses match the engine under your rules");
    assert.ok(!exp.pills.includes("Blocked"), "nothing needs blocking: the agent stayed within budget");
    assert.match(await bnums(page), new RegExp(`Paid \\$${exp.paid}\\b`));
    assert.match(await page.locator(".receipt").innerText(), new RegExp(`Paid \\$${exp.paid} of \\$120`));
  });
}

await check("390px: a limit above the budget is clamped with a short note, and Reset goes back", { width: 390, height: 844 }, async (page) => {
  await page.locator("#budget").fill("120");
  await page.locator("#ask").fill("200");
  await page.locator("#ask").press("Enter");
  await page.waitForTimeout(200);
  assert.equal(await page.locator("#ask").inputValue(), "120");
  assert.match(await page.locator("#rules-preview").innerText(), /Approval limit can't be above your budget/);
  await page.locator("#ask").press("ArrowDown");
  assert.equal(await page.locator("#ask").inputValue(), "115", "arrow keys step the field");
  await btn(page, "Reset").click();
  await page.waitForTimeout(200);
  assert.equal(await page.locator("#budget").inputValue(), "300");
  assert.equal(await page.locator("#ask").inputValue(), "100");
  assert.match(await page.locator(".goal").innerText(), /Budget \$300\./);
});

await check("390px: decimals round to whole dollars, letters are refused, money has commas", { width: 390, height: 844 }, async (page) => {
  await page.locator("#budget").fill("150.5");
  await page.locator("#budget").press("Enter");
  await page.waitForTimeout(200);
  assert.equal(await page.locator("#budget").inputValue(), "151");
  assert.match(await page.locator("#rules-preview").innerText(), /Rounded to whole dollars/);
  await page.locator("#budget").fill("abc");
  await page.locator("#budget").press("Enter");
  await page.waitForTimeout(200);
  assert.equal(await page.locator("#budget").inputValue(), "151", "letters keep the budget in force");
  assert.match(await page.locator("#rules-preview").innerText(), /Use whole dollars/);
  await page.locator("#budget").fill("1000");
  await page.locator("#budget").press("Enter");
  await page.waitForTimeout(200);
  assert.match(await bnums(page), /Budget \$1,000\b/);
  assert.match(await page.locator(".goal").innerText(), /Budget \$1,000\./);
  assert.match(await page.locator("#selection option:checked").innerText(), /\(\$1,000\)/, "the mission option shows your budget");
});

await check("1440px: a shared link sets the deal and rules; bad values fall back", { width: 1440, height: 900 }, async (page) => {
  await page.goto(`${BASE_URL}/?deal=7&budget=150&ask=60`, { waitUntil: "networkidle" });
  assert.equal(await page.locator("#seed").inputValue(), "7");
  assert.equal(await page.locator("#budget").inputValue(), "150");
  assert.equal(await page.locator("#ask").inputValue(), "60");
  assert.match(await page.locator(".goal-box .note").innerText(), /Deal #7 always replays the same deal\./);
  await page.goto(`${BASE_URL}/?deal=abc&budget=5&ask=900`, { waitUntil: "networkidle" });
  assert.equal(await page.locator("#seed").inputValue(), "42");
  assert.equal(await page.locator("#budget").inputValue(), "300");
  assert.equal(await page.locator("#ask").inputValue(), "100");
  assert.equal(new URL(page.url()).search, "", "the default deal keeps a clean address");
});

await check("1440px: all three booths show a one-on-one chat after Skip", { width: 1440, height: 900 }, async (page) => {
  await skip(page);
  const counts = await page.$$eval(".booth", (els) => els.map((e) => [e.offsetParent !== null, e.querySelectorAll(".msg .b").length]));
  assert.equal(counts.length, 3, "three booths");
  for (const [visible, n] of counts) {
    assert.ok(visible, "every booth is visible side by side");
    assert.ok(n >= 2, `each booth shows at least two chat bubbles: ${JSON.stringify(counts)}`);
  }
  const sides = await page.$$eval(".booth .msg", (els) => els.map((e) => [e.classList.contains("agent") ? "agent" : "seller", getComputedStyle(e).alignSelf]));
  assert.ok(sides.every(([who, a]) => (who === "agent" ? a === "flex-end" : a === "flex-start")), "agent on the right, seller on the left");
});

await check("390px: booth tabs are tabs and show one booth at a time", { width: 390, height: 844 }, async (page) => {
  await skip(page);
  const tabs = page.getByRole("tab");
  assert.equal(await tabs.count(), 3, "three booth tabs");
  assert.equal(await page.getByRole("tablist").count(), 1, "tabs sit in a tablist");
  assert.equal(await page.locator(".booth:visible").count(), 1, "one booth visible");
  assert.equal(await page.getByRole("tabpanel").count(), 1, "only the shown booth is an exposed tab panel");
  await tabs.nth(2).click();
  assert.equal(await tabs.nth(2).getAttribute("aria-selected"), "true");
  const shown = await page.locator(".booth:visible").getAttribute("id");
  assert.equal(shown, await tabs.nth(2).getAttribute("aria-controls"), "tapped tab shows its booth");
  await page.keyboard.press("ArrowRight");
  assert.equal(await tabs.nth(0).getAttribute("aria-selected"), "true", "ArrowRight wraps to the first tab and selects it");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("role")), "tab", "focus follows the arrow keys");
  assert.equal(await page.locator(".booth:visible").getAttribute("id"), await tabs.nth(0).getAttribute("aria-controls"));
  await page.keyboard.press("ArrowLeft");
  assert.equal(await tabs.nth(2).getAttribute("aria-selected"), "true", "ArrowLeft moves back");
  const live = await page.$$eval(".booth .log", (els) => els.map((e) => [e.offsetParent !== null, e.getAttribute("aria-live")]));
  assert.ok(live.every(([visible, mode]) => (visible ? mode === "polite" : mode === "off")), `only the visible chat is live: ${JSON.stringify(live)}`);
});

await check("390px: after Skip the visible booth is the seller the deal went to", { width: 390, height: 844 }, async (page) => {
  let checked = 0;
  for (const id of ["stickers", "energy-drinks", "portable-monitor", "logo-designer", "video-editor", "ai-credits", "font-license", "hosting-starter", "usb-mic"]) {
    const o = buildSingleRun(id, 42).lines[0].deal.outcome;
    if (o.status !== "deal") continue;
    await page.selectOption("#selection", `item:${id}`);
    await skip(page);
    assert.equal(await page.locator(".booth:visible").getAttribute("id"), `booth-${o.sellerId}`, `${id}: shows ${o.sellerName}`);
    if (await page.getByRole("dialog").count()) await btn(page, "Decline").click();
    checked++;
  }
  assert.ok(checked >= 3, `checked enough items: ${checked}`);
  await btn(page, /rogue/i).click();
  await skip(page);
  const rogue = buildSingleRun("usb-mic", 42, true).lines[0].deal.outcome;
  assert.equal(await page.locator(".booth:visible").getAttribute("id"), `booth-${rogue.sellerId}`, `rogue: shows the blocked seller ${rogue.sellerName}`);
  assert.match(await page.locator(".booth:visible").innerText(), /Blocked/);
});

await check("1440px: losing sellers get a closing note and fees count in the gap", { width: 1440, height: 900 }, async (page) => {
  await btn(page, /rogue/i).click();
  await skip(page);
  const notes = await page.locator(".booth .sys").allTextContents();
  assert.equal(notes.length, 2, "both losing sellers get a note");
  for (const n of notes) assert.match(n, /Out of the running — your agent went with /);
  assert.match(await page.locator(".receipt").innerText(), /nothing spent/);
  assert.doesNotMatch(await page.locator(".receipt").innerText(), /saved \$0/);
  // A seller's checkout fee is part of the ask the agent compares against.
  await page.selectOption("#selection", "item:usb-mic");
  await skip(page);
  const run = buildSingleRun("usb-mic", 42);
  const v = deriveView(run, buildSteps(run, {}).steps, Infinity);
  const feeBooth = v.booths.find((b) => b.fee !== null && b.feeNow);
  assert.ok(feeBooth, "table 42 has a seller with a checkout fee");
  const ask = await page.locator(`#booth-${feeBooth.id} .g-end.ask`).innerText();
  assert.equal(ask.replace(/\s+/g, " "), `Ask $${feeBooth.price + feeBooth.fee} incl. fee`);
});

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
