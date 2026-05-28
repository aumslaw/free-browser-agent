/**
 * test/e2e/claude-clone-verify.mjs
 *
 * Verifies the Claude-in-Chrome features added to free-browser-agent WITHOUT
 * needing a live LLM provider key:
 *   1. PERSISTENCE — a conversation seeded into chrome.storage.local loads on open.
 *   2. MARKDOWN    — a stored assistant message with a fenced code block renders <pre>.
 *   3. HISTORY     — the history sidebar lists the conversation; New chat resets the view.
 *
 * (Streaming is the pre-existing agent:delta path, preserved verbatim + covered by
 *  unit tests; it needs a configured provider to exercise live, so it's out of scope here.)
 *
 * Run: node test/e2e/claude-clone-verify.mjs
 */
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(__dirname, "../../dist");
const OUT = resolve(__dirname, "../../output/claude-clone");
mkdirSync(OUT, { recursive: true });

const pass = [];
const fail = [];
const check = (name, cond, detail = "") => {
  (cond ? pass : fail).push(name);
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ctx = await chromium.launchPersistentContext(resolve(tmpdir(), `fba-clone-${Date.now()}`), {
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-first-run"],
});

let exitCode = 0;
try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  console.log(`extension id: ${extId}`);

  const panel = await ctx.newPage();
  panel.on("pageerror", (e) => console.log("  [panel error]", e.message));
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
  await panel.waitForLoadState("networkidle");
  await panel.waitForTimeout(600);

  // Seed a conversation directly into the store (no LLM needed).
  const seed = {
    id: "seed-conv-1",
    title: "show me hello world in python",
    createdAt: Date.now() - 5000,
    updatedAt: Date.now() - 5000,
    messages: [
      { id: "u1", role: "user", text: "show me hello world in python" },
      { id: "a1", role: "assistant", text: 'Here you go:\n\n```python\nprint("Hello, world!")\n```\n\nThat prints a greeting.' },
    ],
  };
  await panel.evaluate(
    (s) =>
      new Promise((r) =>
        chrome.storage.local.set({ "fba:conversations": { "seed-conv-1": s }, "fba:lastActive": "seed-conv-1" }, () => r())
      ),
    seed
  );

  // Reload → App loads last-active from storage.
  await panel.reload();
  await panel.waitForLoadState("networkidle");
  await panel.waitForTimeout(1200);

  // 1. PERSISTENCE — the seeded user message rendered after load.
  const bodyText = await panel.evaluate(() => document.body.innerText);
  check("persistence: seeded conversation loads on open", bodyText.includes("show me hello world in python"));

  // 2. MARKDOWN — the assistant code block rendered as <pre>.
  const [hasPre, preText] = await panel.evaluate(() => {
    const pre = document.querySelector('[data-testid="assistant-msg"] pre');
    return [!!pre, pre ? (pre.textContent || "") : ""];
  });
  check("markdown: stored code block renders as <pre>", hasPre && /Hello, world!/.test(preText), preText.slice(0, 40));
  await panel.screenshot({ path: resolve(OUT, "1-loaded-markdown.png"), fullPage: true });

  // 3. HISTORY — sidebar lists the conversation.
  await panel.locator('[data-testid="history-toggle"]').click();
  await panel.waitForTimeout(400);
  const convCount = await panel.evaluate(() => document.querySelectorAll('[data-testid="conversation-item"]').length);
  check("history: sidebar lists the conversation", convCount >= 1, `${convCount} conversation(s)`);
  await panel.screenshot({ path: resolve(OUT, "2-history.png"), fullPage: true });

  // 4. NEW CHAT — resets to welcome + adds a second conversation.
  await panel.locator('[data-testid="new-chat"]').click();
  await sleep(500);
  const welcome = await panel.evaluate(() => /Tell me what to do/i.test(document.body.innerText));
  check("new chat: resets to a fresh conversation", welcome);
  await panel.locator('[data-testid="history-toggle"]').click();
  await panel.waitForTimeout(400);
  const convCount2 = await panel.evaluate(() => document.querySelectorAll('[data-testid="conversation-item"]').length);
  check("new chat: history now has 2 conversations", convCount2 >= 2, `${convCount2} conversation(s)`);
  await panel.screenshot({ path: resolve(OUT, "3-after-new-chat.png"), fullPage: true });

  console.log(`\n──────── RESULT: ${pass.length} passed, ${fail.length} failed ────────`);
  if (fail.length) { console.log("FAILURES:\n  " + fail.join("\n  ")); exitCode = 1; }
  console.log(`screenshots: ${OUT}`);
} catch (err) {
  console.error("E2E ERROR:", err);
  exitCode = 2;
} finally {
  await ctx.close();
}
process.exit(exitCode);
