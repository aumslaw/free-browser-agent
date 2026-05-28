/**
 * test/e2e/files-voice-verify.mjs
 *
 * In-browser check (no server / no LLM) that the file-attach + voice UI is wired:
 *   1. mic button present (voice dictation affordance)
 *   2. attach (paperclip) button present
 *   3. attaching a text file via the hidden file input shows an attachment chip
 *
 * Run: node test/e2e/files-voice-verify.mjs
 */
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(__dirname, "../../dist");
const OUT = resolve(__dirname, "../../output/files-voice");
mkdirSync(OUT, { recursive: true });

const sampleTxt = resolve(tmpdir(), `attach-sample-${Date.now()}.txt`);
writeFileSync(sampleTxt, "Hello from an attached text file.");

const pass = [];
const fail = [];
const check = (name, cond, detail = "") => {
  (cond ? pass : fail).push(name);
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const ctx = await chromium.launchPersistentContext(resolve(tmpdir(), `fv-${Date.now()}`), {
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-first-run"],
});

let exitCode = 0;
try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  const panel = await ctx.newPage();
  panel.on("pageerror", (e) => console.log("  [panel error]", e.message));
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
  await panel.waitForLoadState("networkidle");
  await panel.waitForTimeout(800);

  const hasMic = await panel.evaluate(() => !!document.querySelector('[data-testid="mic"]'));
  check("voice: mic button present", hasMic);

  const hasAttach = await panel.evaluate(() => !!document.querySelector('[data-testid="attach"]'));
  check("attach: paperclip button present", hasAttach);

  // Attach a text file via the hidden file input → expect a chip.
  const fileInput = panel.locator('input[type="file"]').first();
  await fileInput.setInputFiles(sampleTxt);
  await panel.waitForTimeout(800);
  const chipCount = await panel.evaluate(() => document.querySelectorAll('[data-testid="attachment-chip"]').length);
  check("attach: attaching a file shows a chip", chipCount >= 1, `${chipCount} chip(s)`);

  await panel.screenshot({ path: resolve(OUT, "attach-chip.png"), fullPage: true });

  console.log(`\n──────── RESULT: ${pass.length} passed, ${fail.length} failed ────────`);
  if (fail.length) { console.log("FAILURES:\n  " + fail.join("\n  ")); exitCode = 1; }
} catch (err) {
  console.error("E2E ERROR:", err);
  exitCode = 2;
} finally {
  await ctx.close();
}
process.exit(exitCode);
