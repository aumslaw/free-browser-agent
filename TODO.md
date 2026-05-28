# free-browser-agent — TODO

**Canonical, single source of truth for this repo's open work.**

Format: `- [ ]` open, `- [x]` done (with date + commit), `- [~]` partial.

---

## P0 — current focus

- [~] **[BL-ONB-E2E]** (2026-05-26) **Live-test the 3 onboarding methods.** Partially closed
  2026-05-28: the unpacked extension loads in real Chromium (Playwright e2e 3/3), and the
  options/onboarding page now **renders all three paths live** (Sign in with OpenRouter / Use
  Chrome built-in AI / Auto-provision) — verified via screenshot capture. A loading-hang bug
  was found + fixed (see Done). What remains is **genuinely human-only** and cannot be agent-automated:
  - (a) **OpenRouter OAuth** — completing the real consent screen in a logged-in browser.
  - (b) **Chrome built-in AI** — needs a Chrome build with the Prompt API flag enabled + first-use
    Gemini Nano model download (a one-time human/browser step).
  - (c) **Auto-provision** — real run depends on being logged into Google AND clearing any CAPTCHA;
    the happy-path UI is verified, the live key-creation needs a human session.

## P1 — next up

_(none currently — BL-DOMOPS-READTEXT shipped 2026-05-28)_

## Done (last 30 days)

- [x] **[BL-ONB-LOADING-HANG]** options/settings page hung forever on "Loading…" in a fresh
  profile — `loadData()` awaited `chrome.runtime.sendMessage` which can stay pending indefinitely
  when the MV3 SW returns `true` but never calls `sendResponse` (cold start). Fixed by racing each
  message against a 2.5s timeout so the settings UI always renders. tsc clean, 283 tests green,
  onboarding renders verified via live screenshot. (2026-05-28 — found in main-thread Playwright E2E)
- [x] **[BL-DOMOPS-READTEXT]** `readText` + `getElementCoords` ops added to `src/content/dom-ops.ts`
  and dispatch-wired; `auto-provision.ts` already called both as primary paths, so this closes the
  content-script loop (CDP is now true fallback only). +7 tests, suite 276→283 green. (2026-05-28 —
  PRD: aum-ops-agent `agent/logs/prds/browser-agents-do-it-all-2026-05-28.md`, SA-1)
- [x] **[BL-ONB-3WAY]** 3 selectable onboarding methods (OpenRouter OAuth PKCE / Chrome Nano via offscreen doc / auto-provision) wired + tested — 227/227 tests, tsc clean, `vite build` → loadable `dist/`. Manual key-paste demoted to an "Advanced" expander. (2026-05-26 — PRD: aum-ops-agent `agent/logs/prds/free-browser-agent-onboarding-3way-2026-05-26.md`)
- [x] **[BL-DOMOPS-CONTENTEDITABLE]** `dom-ops.type()` contenteditable detection via attribute fallback (robust beyond `isContentEditable`) + link-URL test corrected to normalized `.href`. Suite 192→194 green. (2026-05-26)
