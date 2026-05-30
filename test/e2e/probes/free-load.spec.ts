// @ts-nocheck
/* eslint-disable */

/**
 * free-load.spec.ts
 *
 * Stress-test probe: Extension loads (manifest valid) + service worker registers.
 *
 * Asserts:
 *   1. A service worker registers within 10s.
 *   2. The extension ID matches /^[a-p]{32}$/ (Chrome MV3 format).
 *   3. chrome-extension://<id>/sidepanel.html loads without uncaught errors.
 */

import { test, expect, chromium } from "playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST = path.resolve(__dirname, "../../../dist");

test("extension loads and service worker registers", async () => {
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
    // ── 1. Wait for service worker ──────────────────────────────────────────
    let sw = context.serviceWorkers()[0];
    if (!sw) {
      sw = await context.waitForEvent("serviceworker", { timeout: 10000 });
    }
    expect(sw, "service worker must exist").toBeTruthy();

    // ── 2. Validate extension ID ────────────────────────────────────────────
    const extId = new URL(sw.url()).hostname;
    expect(extId, `extId "${extId}" must be 32 lowercase [a-p] chars`).toMatch(
      /^[a-p]{32}$/
    );

    // ── 3. Open sidepanel.html and assert no uncaught errors ────────────────
    const page = await context.newPage();

    const uncaughtErrors: string[] = [];
    page.on("pageerror", (err) => uncaughtErrors.push(err.message));

    await page.goto(`chrome-extension://${extId}/sidepanel.html`, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });

    // Give the page a moment to settle and surface any runtime errors
    await page.waitForTimeout(1500);

    expect(
      uncaughtErrors,
      `sidepanel.html threw uncaught errors: ${uncaughtErrors.join("; ")}`
    ).toHaveLength(0);

    // Confirm the page actually rendered something (not a blank/error page)
    const bodyText = await page.locator("body").textContent();
    // The body should have some content (the side panel UI)
    expect(bodyText?.trim().length ?? 0, "sidepanel body must not be empty").toBeGreaterThan(0);

    await page.close();
  } finally {
    await context.close();
  }
});
