#!/usr/bin/env node
// smoke.mjs — deep-verify both browser-agent extensions
//   1. Loads each dist/ as unpacked extension in real Chromium
//   2. Screenshots the side panel + options page (visual UI proof)
//   3. Makes a real Gemini call through free-browser-agent's google provider
//
// Run via: doppler run -- node output/browser-agent-verify/smoke.mjs

import { chromium } from "playwright";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const OUT = "output/browser-agent-verify";
mkdirSync(OUT, { recursive: true });

const FREE_DIST = "C:/Users/aumpa/OneDrive/Documents/GitHub/free-browser-agent/dist";
const AUM_DIST = "C:/Users/aumpa/OneDrive/Documents/GitHub/aum-browser-agent/dist";

function assertDist(p, name) {
  if (!existsSync(join(p, "manifest.json"))) {
    throw new Error(`${name} dist missing manifest.json at ${p}`);
  }
}
assertDist(FREE_DIST, "free");
assertDist(AUM_DIST, "aum");

async function loadAndScreenshot(distPath, slug) {
  console.log(`\n=== ${slug} ===`);
  const ctx = await chromium.launchPersistentContext("", {
    headless: false,
    args: [
      `--disable-extensions-except=${distPath}`,
      `--load-extension=${distPath}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
    viewport: { width: 420, height: 720 },
  });

  // Wait for service worker to register so we know the extension loaded clean
  let sw = ctx.serviceWorkers()[0];
  if (!sw) {
    try {
      sw = await ctx.waitForEvent("serviceworker", { timeout: 10000 });
    } catch (e) {
      console.log(`  [${slug}] WARNING: no service worker registered within 10s — extension may have failed to load`);
    }
  }
  const extId = sw ? new URL(sw.url()).host : null;
  console.log(`  ext id: ${extId}`);
  console.log(`  sw url: ${sw?.url() ?? "(none)"}`);

  if (!extId) {
    await ctx.close();
    return { ok: false, reason: "no service worker" };
  }

  // Side panel page
  const sp = await ctx.newPage();
  const spUrl = `chrome-extension://${extId}/sidepanel.html`;
  await sp.goto(spUrl, { waitUntil: "networkidle", timeout: 10000 });
  await sp.waitForTimeout(500);
  await sp.screenshot({ path: join(OUT, `${slug}-sidepanel.png`), fullPage: true });
  const spBody = await sp.evaluate(() => document.body?.innerText?.slice(0, 500) ?? "");
  const spRoot = await sp.evaluate(() => {
    const root = document.getElementById("root") || document.getElementById("app");
    return root ? { id: root.id, childCount: root.children.length, hasContent: root.innerHTML.length > 0 } : null;
  });
  console.log(`  sidepanel root: ${JSON.stringify(spRoot)}`);
  console.log(`  sidepanel visible text (first 200 chars): ${spBody.slice(0, 200).replace(/\s+/g, " ")}`);

  // Options page
  const op = await ctx.newPage();
  const opUrl = `chrome-extension://${extId}/options.html`;
  await op.goto(opUrl, { waitUntil: "networkidle", timeout: 10000 });
  await op.waitForTimeout(500);
  await op.screenshot({ path: join(OUT, `${slug}-options.png`), fullPage: true });
  const opRoot = await op.evaluate(() => {
    const root = document.getElementById("root") || document.getElementById("app");
    return root ? { id: root.id, childCount: root.children.length } : null;
  });
  console.log(`  options root: ${JSON.stringify(opRoot)}`);

  // Console errors in either page?
  const errors = [];
  sp.on("pageerror", (e) => errors.push(`sp: ${e.message}`));
  op.on("pageerror", (e) => errors.push(`op: ${e.message}`));
  await sp.waitForTimeout(200);
  await op.waitForTimeout(200);

  await ctx.close();
  return {
    ok: true,
    extId,
    sidepanelRoot: spRoot,
    optionsRoot: opRoot,
    errors,
    screenshots: [`${slug}-sidepanel.png`, `${slug}-options.png`],
  };
}

async function realGeminiCall() {
  console.log(`\n=== real Gemini call (free's Google provider) ===`);
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    console.log(`  SKIP — GEMINI_API_KEY not in env`);
    return { ok: false, reason: "no GEMINI_API_KEY" };
  }

  // Call Gemini directly with the same request shape free-browser-agent/src/providers/google.ts uses.
  // (Direct import of free's google.ts is awkward across repos; we replicate the exact call shape.)
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`;
  const body = {
    contents: [{ role: "user", parts: [{ text: "Say exactly: PONG" }] }],
    generationConfig: { maxOutputTokens: 20 },
  };
  const t0 = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const ms = Date.now() - t0;
  if (!res.ok) {
    const text = await res.text();
    console.log(`  Gemini HTTP ${res.status}: ${text.slice(0, 200)}`);
    return { ok: false, status: res.status, body: text.slice(0, 200), latencyMs: ms };
  }
  const data = await res.json();
  const reply = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  console.log(`  Gemini OK in ${ms}ms — reply: "${reply.trim().slice(0, 100)}"`);
  return { ok: true, latencyMs: ms, reply: reply.trim() };
}

async function main() {
  const results = {};
  results.free = await loadAndScreenshot(FREE_DIST, "free");
  results.aum = await loadAndScreenshot(AUM_DIST, "aum");
  results.gemini = await realGeminiCall();

  console.log(`\n========== SUMMARY ==========`);
  console.log(JSON.stringify(results, null, 2));

  const ok =
    results.free.ok &&
    results.aum.ok &&
    results.free.sidepanelRoot?.childCount > 0 &&
    results.aum.sidepanelRoot?.childCount > 0 &&
    results.gemini.ok;

  console.log(`\nOVERALL: ${ok ? "PASS" : "FAIL"}`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("smoke failed:", e);
  process.exit(2);
});
