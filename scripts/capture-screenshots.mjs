#!/usr/bin/env node
// One-shot: load the unpacked dist/ extension in headed Chromium, resolve its
// extension id from the service worker, and screenshot the side panel + options
// (onboarding) pages into docs/screenshots/ for the README.
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const OUT = join(ROOT, "docs", "screenshots");
mkdirSync(OUT, { recursive: true });

const ctx = await chromium.launchPersistentContext("", {
  headless: false,
  args: [
    `--disable-extensions-except=${DIST}`,
    `--load-extension=${DIST}`,
  ],
});

// Resolve the extension id from the (eventually registered) service worker.
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 10000 });
const extId = new URL(sw.url()).host;
console.log("[capture] extension id:", extId);

const page = await ctx.newPage();
page.setViewportSize({ width: 420, height: 760 }); // side-panel proportions

await page.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: "load" });
await page.waitForTimeout(1200);
await page.screenshot({ path: join(OUT, "sidepanel.png") });
console.log("[capture] wrote sidepanel.png");

await page.setViewportSize({ width: 720, height: 820 });
await page.goto(`chrome-extension://${extId}/options.html`, { waitUntil: "networkidle" });
// The options app boots async (reads chrome.storage via the SW); loadData settles
// within ~2.5s (timeout-guarded), so wait past that before screenshotting.
await page.waitForFunction(() => !/Loading[.…]+/.test(document.body.innerText), { timeout: 8000 }).catch(() => {});
await page.waitForTimeout(1000);
await page.screenshot({ path: join(OUT, "onboarding.png"), fullPage: true });
console.log("[capture] wrote onboarding.png");

await ctx.close();
console.log("[capture] done");
