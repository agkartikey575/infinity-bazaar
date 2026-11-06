// Records the demo video from the live site, scene by scene, following the
// submission script, then cuts it to length with ffmpeg.
//
//   BASE_URL=https://infinity-bazaar.vercel.app OUT=/tmp/demo node scripts/record-demo.mjs
//
// With PAYPAL_SANDBOX_BUYER_EMAIL / PAYPAL_SANDBOX_BUYER_PASSWORD set, the PayPal
// scene uses a real sandbox checkout window; without them that scene is skipped.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const BASE_URL = process.env.BASE_URL ?? "https://infinity-bazaar.vercel.app";
const OUT = process.env.OUT ?? "/tmp/demo";
const LIVE = Boolean(process.env.PAYPAL_SANDBOX_BUYER_EMAIL && process.env.PAYPAL_SANDBOX_BUYER_PASSWORD);
const SIZE = { width: 1440, height: 900 };
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: SIZE, recordVideo: { dir: OUT, size: SIZE }, colorScheme: "light" });
const t0 = Date.now();
const page = await ctx.newPage();
const marks = [];
let popupVideo = null;
const mark = (name) => marks.push({ name, t: (Date.now() - t0) / 1000 });
const wait = (ms) => page.waitForTimeout(ms);
const btn = (name) => page.getByRole("button", { name, exact: typeof name === "string" });
const scrollTo = (sel) => page.locator(sel).first().evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" })).catch(() => undefined);
const table = async (n) => {
  await page.locator("#seed").fill(String(n));
  await page.locator("#seed").press("Enter");
};

await page.goto(BASE_URL, { waitUntil: "networkidle" });
await wait(1500);

// 1. Intro: the mission card.
mark("intro");
await wait(14000);

// 2–3. Haggling on table 42, then the first deal and AgentGuard.
mark("haggle");
await page.selectOption("#speed", "2");
await btn(/^(Play|Replay)$/).first().click();
await page.getByText("Hidden fee spotted", { exact: false }).first().waitFor({ timeout: 90_000 }).catch(() => undefined);
await wait(6000);
await page.getByText("Approved. It fits your budget", { exact: false }).first().waitFor({ timeout: 120_000 }).catch(() => undefined);
await scrollTo(".gate, .paypal");
await wait(5000);
mark("haggle-end");

// 4–5. Real PayPal: a shipped item is held, then paid on delivery.
if (LIVE) {
  const { approveInPayPal } = await import("../tests/e2e/paypal-helpers.mjs");
  mark("paypal");
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  await page.getByLabel(/PayPal (\(sandbox\)|sandbox)/i).check();
  await page.locator("#selection").selectOption("item:usb-mic");
  await table(1);
  await page.selectOption("#speed", "4");
  const pay = btn("Pay with PayPal");
  await pay.waitFor({ timeout: 120_000 });
  await scrollTo("#pay-with-paypal");
  await wait(1500);
  const [popup] = await Promise.all([page.waitForEvent("popup"), pay.click()]);
  mark("paypal-window");
  popupVideo = popup.video();
  await approveInPayPal(popup);
  mark("paypal-back");
  await page.locator(".list .pill", { hasText: /Paid|Hold released/ }).first().waitFor({ timeout: 120_000 });
  await page.getByLabel("Show PayPal details").check();
  await scrollTo(".paypal");
  await wait(7000);
  mark("paypal-end");
  await page.getByLabel(/PayPal (\(sandbox\)|sandbox)/i).uncheck();
}

// 6. Above the approval line, the agent asks first.
mark("ask");
await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
await page.locator("#selection").selectOption("mission:hackathon-10-days");
await table(7);
await page.selectOption("#speed", "4");
for (let i = 0; i < 20 && !(await page.getByRole("dialog").count()); i++) {
  const skip = btn(/Skip/);
  if (await skip.isEnabled()) await skip.click();
  await wait(700);
}
await wait(4000);
await btn(/^Approve/).click();
await wait(2500);
mark("ask-end");

// 7. The rogue agent: talked into a $140 upsell, stopped by AgentGuard.
mark("rogue");
await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
await btn("Agent goes rogue").click();
await page.selectOption("#speed", "2");
await page.getByText("Nothing was sent to PayPal", { exact: false }).first().waitFor({ timeout: 120_000 }).catch(() => undefined);
await wait(1500);
await scrollTo(".gate");
await wait(7000);
mark("rogue-end");

// 8. Receipt and close.
mark("outro");
await scrollTo(".receipt");
await wait(4000);
await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
await wait(5000);
mark("outro-end");

const video = page.video();
await ctx.close();
await browser.close();
const raw = await video.path();
const popupRaw = popupVideo ? await popupVideo.path() : null;
fs.writeFileSync(path.join(OUT, "marks.json"), JSON.stringify({ raw, marks }, null, 2));

// Cut each scene and fit it to the script's length (speeding up long scenes, never slowing).
const plan = [
  ["intro", "haggle", 15],
  ["haggle", "haggle-end", 50],
  ...(LIVE ? [["paypal", "paypal-window", 12], ["popup", "popup", 22], ["paypal-back", "paypal-end", 16]] : []),
  ["ask", "ask-end", 20],
  ["rogue", "rogue-end", 25],
  ["outro", "outro-end", 10],
];
const at = (n) => marks.find((m) => m.name === n)?.t;
const parts = [];
const popupLen = popupRaw ? Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", popupRaw]).toString().trim()) : 0;
plan.forEach(([a, b, target], i) => {
  const isPopup = a === "popup";
  const src = isPopup ? popupRaw : raw;
  const start = isPopup ? 0 : at(a), end = isPopup ? popupLen : at(b);
  if (!src || start === undefined || end === undefined) return;
  const len = end - start;
  const speed = Math.max(1, len / target);
  const out = path.join(OUT, `part-${i}.mp4`);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(start), "-t", String(len), "-i", src, "-vf", `setpts=PTS/${speed.toFixed(3)},fps=30`, "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", out]);
  parts.push(out);
  console.log(`${a}: ${len.toFixed(1)}s -> ${(len / speed).toFixed(1)}s (x${speed.toFixed(2)})`);
});
const list = path.join(OUT, "parts.txt");
fs.writeFileSync(list, parts.map((p) => `file '${p}'`).join("\n"));
const final = path.join(OUT, "infinity-bazaar-demo.mp4");
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", final]);
const dur = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", final]).toString().trim();
console.log(`final: ${final} (${Number(dur).toFixed(1)}s)`);
