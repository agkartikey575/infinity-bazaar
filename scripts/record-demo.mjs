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
// Blur any email address shown in the PayPal window, so the sandbox login never appears on screen.
await ctx.addInitScript(() => {
  if (!/paypal\.com$/.test(location.hostname)) return;
  const css = "#email, [data-testid*='email' i], .blurred-email { filter: blur(6px) !important; }";
  const hide = () => {
    if (!document.head) return;
    if (!document.getElementById("demo-blur")) {
      const st = document.createElement("style");
      st.id = "demo-blur";
      st.textContent = css;
      document.head.appendChild(st);
    }
    const walk = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) if (/\S+@\S+/.test(n.nodeValue) && n.parentElement) n.parentElement.classList.add("blurred-email");
  };
  new MutationObserver(hide).observe(document, { childList: true, subtree: true, characterData: true });
  document.addEventListener("DOMContentLoaded", hide);
});
const t0 = Date.now();
const page = await ctx.newPage();
const marks = [];
let popupVideo = null;
let popupBox = null;
const mark = (name) => marks.push({ name, t: (Date.now() - t0) / 1000 });
const wait = (ms) => page.waitForTimeout(ms);
const btn = (name) => page.getByRole("button", { name, exact: typeof name === "string" });
const scrollTo = (sel) => page.locator(sel).first().evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" })).catch(() => undefined);
const table = async (n) => {
  await page.locator("#seed").fill(String(n));
  await page.locator("#seed").press("Enter");
};


// A "camera" that follows the action: the chats and commentary while sellers
// talk, the AgentGuard check and PayPal panel when a payment decision lands.
const installCamera = () =>
  page.evaluate(() => {
    if (window.__cam) return;
    window.__cam = "auto";
    let last = "", until = 0;
    const decisive = /Approved\.|Blocked because|Needs your OK|Paid \$|held by PayPal|Delivered|released|order created|Waiting for your approval|declined/;
    setInterval(() => {
      const mode = window.__cam, y = window.scrollY;
      const go = (top) => { top = Math.max(0, Math.round(top)); if (Math.abs(top - y) > 40) window.scrollTo({ top, behavior: "smooth" }); };
      const at = (el, off) => el && go(el.getBoundingClientRect().top + window.scrollY - off);
      if (mode === "off") return;
      if (mode === "top") return go(0);
      if (mode === "receipt") return at(document.querySelector(".receipt"), 140);
      if (document.querySelector("[role=dialog]")) return;
      const gate = document.querySelector(".gate"), pay = document.querySelector(".paypal");
      const text = (gate?.innerText ?? "") + "|" + (pay?.innerText ?? "");
      if (text !== last) { if (decisive.test(text)) until = Date.now() + 4000; last = text; }
      // Payment moment: slide down just enough to show the whole AgentGuard check and PayPal panel.
      if (Date.now() < until) {
        const bottom = Math.max(gate?.getBoundingClientRect().bottom ?? 0, pay?.getBoundingClientRect().bottom ?? 0) + window.scrollY;
        return go(bottom - window.innerHeight + 24);
      }
      // The deal: budget bar, price card, three chats with their gap bars, and the live commentary.
      at(document.querySelector(".mission"), 10);
    }, 500);
  });
const cam = (mode) => page.evaluate((m) => (window.__cam = m), mode);
await page.goto(BASE_URL, { waitUntil: "networkidle" });
await installCamera();
await cam("top");
await wait(1500);

// 1. Intro: the mission card.
mark("intro");
await wait(14000);

// 2–3. Haggling on table 42, then the first deal and AgentGuard.
mark("haggle");
await cam("auto");
await page.selectOption("#speed", "2");
await btn(/^(Play|Replay)$/).first().click();
await page.getByText("Hidden fee spotted", { exact: false }).first().waitFor({ timeout: 90_000 }).catch(() => undefined);
await wait(6000);
await page.getByText("Approved. It fits your budget", { exact: false }).first().waitFor({ timeout: 120_000 }).catch(() => undefined);

await wait(5000);
mark("haggle-end");

// 4–5. Real PayPal: a shipped item is held, then paid on delivery.
if (LIVE) {
  const { loginInPayPal, PAY_BUTTON } = await import("../tests/e2e/paypal-helpers.mjs");
  mark("paypal");
  await cam("auto");
  await page.getByLabel(/PayPal (\(sandbox\)|sandbox)/i).check();
  await page.locator("#selection").selectOption("item:usb-mic");
  await table(1);
  await page.selectOption("#speed", "4");
  const pay = btn("Pay with PayPal");
  await pay.waitFor({ timeout: 120_000 });
  
  await wait(1500);
  const [popup] = await Promise.all([page.waitForEvent("popup"), pay.click()]);
  mark("paypal-window");
  popupVideo = popup.video();
  // Same steps as approveInPayPal, paced so each PayPal screen can be read.
  await loginInPayPal(popup);
  popupBox = await popup.evaluate(() => [window.innerWidth, window.innerHeight]).catch(() => null);
  const payNow = popup.locator(PAY_BUTTON).first();
  await payNow.waitFor({ state: "visible", timeout: 45_000 });
  await popup.waitForTimeout(4000);
  await payNow.click();
  await popup.waitForEvent("close", { timeout: 45_000 }).catch(() => undefined);
  mark("paypal-back");
  await page.locator(".list .pill", { hasText: /Paid|Hold released/ }).first().waitFor({ timeout: 120_000 });
  await page.getByLabel("Show PayPal details").check();
  await wait(500);
  await wait(7000);
  mark("paypal-end");
  await page.getByLabel(/PayPal (\(sandbox\)|sandbox)/i).uncheck();
}

// 6. Above the approval line, the agent asks first.
mark("ask");
await cam("auto");
await page.locator("#selection").selectOption("mission:hackathon-10-days");
await table(7);
await page.selectOption("#speed", "4");
for (let i = 0; i < 20 && !(await page.getByRole("dialog").count()); i++) {
  const skip = btn(/Skip/);
  if (await skip.isEnabled()) await skip.click();
  await wait(700);
}
await wait(9000);
await btn(/^Approve/).click();
await wait(4000);
mark("ask-end");

// 7. The rogue agent: talked into a $140 upsell, stopped by AgentGuard.
mark("rogue");
await cam("auto");
await btn("Agent goes rogue").click();
await page.selectOption("#speed", "2");
await page.getByText("Nothing was sent to PayPal", { exact: false }).first().waitFor({ timeout: 120_000 }).catch(() => undefined);
await wait(1500);

await wait(7000);
mark("rogue-end");

// 8. Receipt and close.
mark("outro");
await cam("receipt");
await wait(4000);
await cam("auto");
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
  // The PayPal window is smaller than the recording: crop to it, scale it up and center it.
  const frame = isPopup && popupBox ? `crop=${popupBox[0]}:${popupBox[1]}:0:0,scale=-2:${SIZE.height},pad=${SIZE.width}:${SIZE.height}:(ow-iw)/2:0:color=0xe8edf5,` : "";
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(start), "-t", String(len), "-i", src, "-vf", `${frame}setpts=PTS/${speed.toFixed(3)},fps=30`, "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", out]);
  parts.push(out);
  console.log(`${a}: ${len.toFixed(1)}s -> ${(len / speed).toFixed(1)}s (x${speed.toFixed(2)})`);
});
const list = path.join(OUT, "parts.txt");
fs.writeFileSync(list, parts.map((p) => `file '${p}'`).join("\n"));
const final = path.join(OUT, "infinity-bazaar-demo.mp4");
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", final]);
const dur = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", final]).toString().trim();
console.log(`final: ${final} (${Number(dur).toFixed(1)}s)`);
