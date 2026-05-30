// @ts-nocheck
/* eslint-disable */

/**
 * free-onboarding.spec.ts
 *
 * Stress-test probe: options.html renders all 3 onboarding paths without hanging.
 *
 * Asserts:
 *   1. options.html loads without hanging on a loading spinner.
 *   2. Path 1 — "Sign in with OpenRouter" card is visible.
 *   3. Path 2 — "Use Chrome built-in AI" card is visible.
 *   4. Path 3 — "Auto-provision my keys" card is visible.
 *   5. All 3 action buttons are present and not disabled on initial render.
 */

import { test, expect, chromium } from "playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST = path.resolve(__dirname, "../../../dist");

test("options.html renders all 3 onboarding paths without hanging", async () => {
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

    const extId = new URL(sw.url()).hostname;
    expect(extId, `extId "${extId}" must be 32 lowercase [a-p] chars`).toMatch(
      /^[a-p]{32}$/
    );

    // ── 2. Open options.html ────────────────────────────────────────────────
    const page = await context.newPage();

    const uncaughtErrors: string[] = [];
    page.on("pageerror", (err) => uncaughtErrors.push(err.message));

    await page.goto(`chrome-extension://${extId}/options.html`, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });

    // ── 3. Assert page escapes the loading spinner within 4s ────────────────
    // The known BL-ONB-LOADING-HANG was fixed; "Loading…" must not persist.
    // Wait for loading text to disappear (or never appear).
    await page.waitForFunction(
      () => {
        const body = document.body.innerText;
        return !body.includes("Loading…");
      },
      { timeout: 4000 }
    ).catch(() => {
      throw new Error("options.html still shows 'Loading…' after 4 seconds — BL-ONB-LOADING-HANG not fixed");
    });

    // ── 4. Path 1 — OpenRouter card ─────────────────────────────────────────
    // Label text: "Sign in with OpenRouter"
    const openRouterCard = page.locator("text=Sign in with OpenRouter").first();
    await expect(openRouterCard).toBeVisible({ timeout: 5000 });

    // The button with that text should also be present and enabled
    const openRouterBtn = page.locator("button", { hasText: "Sign in with OpenRouter" });
    await expect(openRouterBtn).toBeVisible();
    await expect(openRouterBtn).not.toBeDisabled();

    // ── 5. Path 2 — Chrome built-in AI card ────────────────────────────────
    // Label text: "Use Chrome built-in AI"
    const chromeAiCard = page.locator("text=Use Chrome built-in AI").first();
    await expect(chromeAiCard).toBeVisible({ timeout: 5000 });

    // The action button for this path
    const chromeAiBtn = page.locator("button", { hasText: "Check Chrome AI availability" });
    await expect(chromeAiBtn).toBeVisible();
    await expect(chromeAiBtn).not.toBeDisabled();

    // ── 6. Path 3 — Auto-provision card ────────────────────────────────────
    // Label text: "Auto-provision my keys"
    const autoProvCard = page.locator("text=Auto-provision my keys").first();
    await expect(autoProvCard).toBeVisible({ timeout: 5000 });

    // The action button for this path
    const autoProvBtn = page.locator("button", { hasText: "Auto-provision" });
    await expect(autoProvBtn).toBeVisible();
    await expect(autoProvBtn).not.toBeDisabled();

    // ── 7. No uncaught errors ───────────────────────────────────────────────
    expect(
      uncaughtErrors,
      `options.html threw uncaught errors: ${uncaughtErrors.join("; ")}`
    ).toHaveLength(0);

    await page.close();
  } finally {
    await context.close();
  }
});
