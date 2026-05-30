// @ts-nocheck
/* eslint-disable */

/**
 * test/e2e/probes/free-domops.spec.ts
 *
 * Stress-tests content-script DOM ops live via SW sendMessage.
 * The content script handles {kind:"dom-op", op:..., args:[...]} directly.
 * SW evaluate() is used to send the message so it reaches the content script.
 *
 * Capabilities tested:
 *   getUrl        — returns {ok, result: {ok, url}}
 *   readPage      — returns {ok, result: {ok, url, title, headings, links, ...}}
 *   readText      — returns {ok, result: {ok, text}}
 *   getElementCoords — returns {ok, result: {ok, x, y}}
 *   dom-digest    — returns {ok, result: {url, title, headings, links, ...}}
 *   type          — inject #probe input, type "hello", verify value
 */

import { test, expect, chromium } from "playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, "../../../dist");

test("Content-script DOM ops live (positional-args envelope)", async () => {
  const context = await chromium.launchPersistentContext("", {
    headless: false,
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      "--no-sandbox",
      "--disable-dev-shm-usage",
    ],
  });

  try {
    // ── get SW and extension ID ──────────────────────────────────────────────
    let sw = context.serviceWorkers()[0];
    if (!sw) {
      sw = await context.waitForEvent("serviceworker", { timeout: 15000 });
    }
    const extId = new URL(sw.url()).hostname;
    console.log("Extension ID:", extId);

    // ── navigate to a real page (content scripts inject on http/https) ───────
    const page = await context.newPage();
    await page.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 20000 });

    // Wait for content script to be ready (brief settle)
    await page.waitForTimeout(1500);

    // Helper: send a dom-op message via SW evaluate → chrome.tabs.sendMessage
    // Content script expects flat {kind:"dom-op", op, args}
    async function domOp(op, args) {
      return await sw.evaluate(
        async ([op, args]) => {
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          const tab = tabs[0];
          if (!tab || !tab.id) return { ok: false, error: "No active tab" };
          return await chrome.tabs.sendMessage(tab.id, { kind: "dom-op", op, args });
        },
        [op, args]
      );
    }

    // Helper: send a dom-digest message via SW
    async function domDigest() {
      return await sw.evaluate(async () => {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tab = tabs[0];
        if (!tab || !tab.id) return { ok: false, error: "No active tab" };
        return await chrome.tabs.sendMessage(tab.id, { kind: "dom-digest" });
      });
    }

    // ── 1. getUrl ────────────────────────────────────────────────────────────
    console.log("Testing getUrl...");
    const urlResp = await domOp("getUrl", []);
    console.log("getUrl response:", JSON.stringify(urlResp));
    expect(urlResp, "getUrl: outer ok").toHaveProperty("ok", true);
    // result is {ok, url}
    const urlResult = urlResp.result ?? urlResp;
    const urlValue = urlResult.url ?? urlResult;
    expect(typeof urlValue === "string" && urlValue.includes("example.com"),
      `getUrl: url should contain example.com, got: ${JSON.stringify(urlValue)}`
    ).toBe(true);

    // ── 2. readPage ──────────────────────────────────────────────────────────
    console.log("Testing readPage...");
    const readPageResp = await domOp("readPage", []);
    console.log("readPage response keys:", Object.keys(readPageResp || {}));
    expect(readPageResp, "readPage: outer ok").toHaveProperty("ok", true);
    // result is a markdown string (from S() function)
    const readPageResult = readPageResp.result ?? readPageResp;
    const readPageText = typeof readPageResult === "string"
      ? readPageResult
      : (readPageResult.text ?? readPageResult.markdown ?? JSON.stringify(readPageResult));
    console.log("readPage text snippet:", String(readPageText).slice(0, 200));
    expect(String(readPageText).toLowerCase()).toContain("example domain");

    // ── 3. readText (selector arg) ───────────────────────────────────────────
    console.log("Testing readText...");
    const readTextResp = await domOp("readText", ["h1"]);
    console.log("readText response:", JSON.stringify(readTextResp));
    expect(readTextResp, "readText: outer ok").toHaveProperty("ok", true);
    const readTextResult = readTextResp.result ?? readTextResp;
    const readTextValue = readTextResult.text ?? readTextResult;
    console.log("readText value:", readTextValue);
    expect(String(readTextValue).toLowerCase()).toContain("example domain");

    // ── 4. getElementCoords (selector arg) ──────────────────────────────────
    console.log("Testing getElementCoords...");
    const coordsResp = await domOp("getElementCoords", ["h1"]);
    console.log("getElementCoords response:", JSON.stringify(coordsResp));
    expect(coordsResp, "getElementCoords: outer ok").toHaveProperty("ok", true);
    const coordsResult = coordsResp.result ?? coordsResp;
    const cx = coordsResult.x ?? coordsResult.result?.x;
    const cy = coordsResult.y ?? coordsResult.result?.y;
    console.log("coords x:", cx, "y:", cy);
    expect(typeof cx, "getElementCoords: x is numeric").toBe("number");
    expect(typeof cy, "getElementCoords: y is numeric").toBe("number");
    expect(cx).toBeGreaterThan(0);
    expect(cy).toBeGreaterThan(0);

    // ── 5. dom-digest ────────────────────────────────────────────────────────
    console.log("Testing dom-digest...");
    const digestResp = await domDigest();
    console.log("dom-digest response keys:", Object.keys(digestResp || {}));
    expect(digestResp, "dom-digest: outer ok").toHaveProperty("ok", true);
    const digestResult = digestResp.result ?? digestResp;
    console.log("dom-digest result:", JSON.stringify(digestResult).slice(0, 300));
    // result from p() function has {url, title, headings, links, formFields}
    expect(digestResult).toHaveProperty("url");
    expect(digestResult).toHaveProperty("title");
    expect(digestResult).toHaveProperty("headings");
    expect(Array.isArray(digestResult.headings), "dom-digest: headings is array").toBe(true);

    // ── 6. type (inject probe, then type) ────────────────────────────────────
    console.log("Testing type...");
    // Inject a probe input into the page
    await page.evaluate(() => {
      const input = document.createElement("input");
      input.id = "probe";
      input.type = "text";
      document.body.appendChild(input);
    });
    await page.waitForTimeout(300);

    const typeResp = await domOp("type", ["#probe", "hello"]);
    console.log("type response:", JSON.stringify(typeResp));
    expect(typeResp, "type: outer ok").toHaveProperty("ok", true);

    // Verify the value was actually set in the DOM
    const probeValue = await page.$eval("#probe", (el) => el.value);
    console.log("probe input value:", probeValue);
    expect(probeValue).toBe("hello");

    await page.close();
  } finally {
    await context.close();
  }
});
