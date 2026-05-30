// @ts-nocheck
/* eslint-disable */
/**
 * test/e2e/probes/free-sidepanel.spec.ts
 *
 * CAPABILITY: Side panel UI renders
 * SCENARIO: Open sidepanel.html; assert the composer textarea renders and
 *           the panel mounts without a thrown error.
 *
 * Composer selector discovered from src/sidepanel/App.tsx:
 *   <textarea aria-label="Message input" ...>
 *   Also has data-testid="attach" button, data-testid="history-toggle", etc.
 */

import { test, expect, chromium } from "playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, "../../../dist");

test("side panel UI renders — composer textarea visible and panel mounts cleanly", async () => {
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
    // ── 1. Resolve extension ID from service worker ────────────────────────
    let sw = context.serviceWorkers()[0];
    if (!sw) {
      sw = await context.waitForEvent("serviceworker", { timeout: 10000 });
    }
    const extId = new URL(sw.url()).hostname;
    expect(extId).toBeTruthy();

    // ── 2. Mock ALL network (routes in context scope cover SW fetch) ───────
    //    The sidepanel calls chrome.storage APIs (no HTTP) on mount, so no
    //    specific routes are needed, but we intercept everything to prevent
    //    any accidental real network call from blocking the test.
    await context.route("**/*", async (route) => {
      const url = route.request().url();
      // Allow chrome-extension:// resources through (Playwright resolves them
      // internally when the extension page loads via page.goto).
      if (url.startsWith("chrome-extension://") || url.startsWith("chrome://")) {
        await route.fallback();
        return;
      }
      // Stub everything else (fonts, analytics, etc.) with 200 OK.
      await route.fulfill({ status: 200, body: "" });
    });

    // ── 3. Open the sidepanel page directly ───────────────────────────────
    const page = await context.newPage();

    // Collect page-level JS errors so we can assert no thrown errors.
    const jsErrors: string[] = [];
    page.on("pageerror", (err) => jsErrors.push(err.message));

    await page.goto(`chrome-extension://${extId}/sidepanel.html`, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });

    // ── 4. Assert panel mounted: #root must have children ─────────────────
    await expect(page.locator("#root")).not.toBeEmpty({ timeout: 8000 });

    // ── 5. Assert the composer textarea is present and visible ────────────
    //    Selector from App.tsx: <textarea aria-label="Message input" ...>
    const composer = page.locator('textarea[aria-label="Message input"]');
    await expect(composer).toBeVisible({ timeout: 8000 });

    // ── 6. Assert the composer is enabled (agent not running on initial load)
    await expect(composer).toBeEnabled();

    // ── 7. Assert placeholder text matches what App.tsx sets ──────────────
    //    placeholder={disabled ? "Agent is running…" : "Ask the agent to do something…"}
    await expect(composer).toHaveAttribute(
      "placeholder",
      "Ask the agent to do something…"
    );

    // ── 8. Assert header elements rendered ───────────────────────────────
    await expect(
      page.locator('[data-testid="history-toggle"]')
    ).toBeVisible({ timeout: 5000 });
    await expect(
      page.locator('[data-testid="new-chat-header"]')
    ).toBeVisible({ timeout: 5000 });

    // ── 9. Assert attach button rendered ─────────────────────────────────
    await expect(page.locator('[data-testid="attach"]')).toBeVisible({
      timeout: 5000,
    });

    // ── 10. Assert no JS exceptions were thrown during mount ──────────────
    expect(jsErrors).toHaveLength(0);
  } finally {
    await context.close();
  }
});
