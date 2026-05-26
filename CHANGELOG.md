# Changelog

All notable changes to Free Browser Agent are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.0] — 2026-05-26

Initial public release.

### Added

**Core agent loop**
- Background service worker with OpenAI-compatible `tools[]` agent loop (max 20 iterations)
- Per-iteration status events streamed to the side panel for live progress display
- Automatic CDP escalation when content-script DOM ops return `{escalate:"cdp"}`

**LLM provider routing**
- Google Gemini adapter (`gemini-2.0-flash-lite`, `gemini-1.5-flash`)
- Groq adapter (`llama-3.3-70b-versatile`, `llama-3.1-8b-instant`)
- Cerebras adapter (`llama3.1-70b`, `llama3.1-8b`)
- OpenRouter free-tier adapter (`:free` suffix models)
- Priority-ordered failover router with per-key RPM/RPD/TPM/TPD rate-limit ledger and exponential-backoff cooldown

**Browser control**
- Content script DOM ops: `click`, `type`, `fillForm`, `scroll`, `readPage` (Readability-style markdown), `waitForSelector`, `getUrl`, `getSelection`
- CDP escalation via `chrome.debugger`: `attach/detach`, `Page.captureScreenshot`, `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`

**Encrypted key storage**
- AES-256-GCM encryption via WebCrypto Subtle API
- Master key stored in `chrome.storage.session` (cleared automatically on browser quit)
- Per-provider key list/save/delete API backed by `chrome.storage.local`

**UI**
- Side panel chat interface (Preact): message list with role badges, streaming text render, tool-call inline display, provider badge per assistant message
- Options page: provider key management, fallback-chain reorder, per-provider connection test

**Build and test**
- MV3 manifest with `debugger`, `scripting`, `sidePanel`, `storage`, `tabs`, `activeTab`, `<all_urls>`
- Multi-entry Vite build (background SW, content script, side panel, options page)
- Vitest unit tests: router failover logic, DOM ops (jsdom), AES-256-GCM round-trip
- Playwright e2e: loads unpacked extension in real Chromium, opens side panel, sends message via mocked provider

[0.1.0]: https://github.com/aumslaw/free-browser-agent/releases/tag/v0.1.0
