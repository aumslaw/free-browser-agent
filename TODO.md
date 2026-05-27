# free-browser-agent — TODO

**Canonical, single source of truth for this repo's open work.**

Format: `- [ ]` open, `- [x]` done (with date + commit), `- [~]` partial.

---

## P0 — current focus

- [ ] **[BL-ONB-E2E]** (2026-05-26) **Live-test the 3 onboarding methods** in the loaded unpacked extension (`chrome://extensions` → enable Developer mode → Load unpacked → `dist/`):
  - (a) **Sign in with OpenRouter** — one-click OAuth (PKCE) → user-owned key stored locally → free models work.
  - (b) **Chrome built-in AI (Gemini Nano)** — zero login, on-device. Needs a Chrome build with the Prompt API enabled + first-use model download; runs via the offscreen document (the SW can't host the Prompt API).
  - (c) **Auto-provision google/groq** — the agent automates key creation in a tab; assumes you're logged into Google; fails gracefully on CAPTCHA / UI drift.
  - Why this is still open: the unit tests mock OAuth + the Prompt API, so only loading the unpacked extension exercises the real end-to-end paths.

## P1 — next up

- [ ] **[BL-DOMOPS-READTEXT]** (2026-05-26 — discovered: SA-ONB-AUTOPROV) Add `readText` + `getElementCoords` ops to `src/content/dom-ops.ts`. auto-provision currently falls back to CDP `Runtime.evaluate` to read the generated key text; once dom-ops exposes `readText`, the content-script path becomes primary with no change to `auto-provision.ts`.

## Done (last 30 days)

- [x] **[BL-ONB-3WAY]** 3 selectable onboarding methods (OpenRouter OAuth PKCE / Chrome Nano via offscreen doc / auto-provision) wired + tested — 227/227 tests, tsc clean, `vite build` → loadable `dist/`. Manual key-paste demoted to an "Advanced" expander. (2026-05-26 — PRD: aum-ops-agent `agent/logs/prds/free-browser-agent-onboarding-3way-2026-05-26.md`)
- [x] **[BL-DOMOPS-CONTENTEDITABLE]** `dom-ops.type()` contenteditable detection via attribute fallback (robust beyond `isContentEditable`) + link-URL test corrected to normalized `.href`. Suite 192→194 green. (2026-05-26)
