# Contributing to Free Browser Agent

Thanks for your interest. Bug reports, provider adapters, and DOM-op improvements are the most useful contributions.

---

## Development loop

### Prerequisites

- Node 20+
- pnpm (`npm install -g pnpm`)
- Chrome 122+ for manual testing

### Setup

```bash
git clone https://github.com/aumslaw/free-browser-agent.git
cd free-browser-agent
pnpm install
```

### Watch mode (rebuild on save)

```bash
pnpm dev
```

This runs `vite build --watch --mode development`. Every time you save a source file, `dist/` is rebuilt.

To see your changes in Chrome:

1. Go to `chrome://extensions`
2. Find Free Browser Agent → click the refresh icon (circular arrow)
3. Reload any tab where the content script is active

### Production build

```bash
pnpm build
```

Produces `dist/` via `build.mjs` (multi-entry Vite build: background SW, content script, side panel, options page).

### Type check

```bash
pnpm tsc
```

This runs `tsc --noEmit`. Fix all errors before opening a PR.

### Unit tests

```bash
pnpm test
```

Runs the Vitest suite (`test/router.test.ts`, `test/dom-ops.test.ts`, `test/crypto.test.ts`).

### End-to-end tests

```bash
pnpm test:e2e
```

Runs Playwright tests in `test/e2e/`. These load the built extension in a real Chromium instance. Requires `pnpm build` first.

---

## Project layout

```
src/
  background/     — service worker, agent loop, CDP helpers
  content/        — content script, DOM operation functions
  providers/      — one file per LLM provider
  router.ts       — failover + rate-limit router
  storage/        — encrypted key storage, rate-limit counters
  sidepanel/      — Preact chat UI
  options/        — Preact settings page
  shared/         — types, message shapes, tool definitions

test/             — unit tests (Vitest + jsdom)
test/e2e/         — Playwright extension tests
```

---

## PR conventions

- **One concern per PR.** Provider additions, bug fixes, and feature work in separate PRs.
- **Tests required.** New provider adapters need a unit test in `test/`. New DOM ops need a jsdom test.
- **No PII in source.** Do not commit API keys, email addresses, or internal endpoint URLs.
- **Type-check must pass.** `pnpm tsc` must exit 0.
- **Tests must pass.** `pnpm test` must exit 0 with no skipped tests.

PR title format:

```
feat: add <provider> adapter
fix: handle <error case> in router
refactor: simplify dom-ops scroll
test: cover crypto round-trip edge cases
docs: update quick-start for Linux
```

---

## Adding a new LLM provider

1. Create `src/providers/<name>.ts` implementing the `Provider` interface from `src/providers/base.ts`:

```ts
import type { Provider, ChatCompletionRequest, ChatCompletionResponse } from "./base.js";

export class MyProvider implements Provider {
  constructor(private apiKey: string) {}

  async chatCompletion(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    // Transform req.messages + req.tools into the provider's wire format
    // Return a ChatCompletionResponse
  }

  async *streamChatCompletion(req: ChatCompletionRequest): AsyncGenerator<string> {
    // Yield text chunks via the provider's SSE or streaming API
  }
}
```

2. Add the new `ProviderId` literal to `src/shared/types.ts` → `ProviderId`.

3. Register the adapter in `src/router.ts` → `buildProvider()`.

4. Add a unit test in `test/router.test.ts` covering at least: successful call, 429 fallover, missing-key skip.

5. Add the provider to the **Supported providers** table in `README.md`.

---

## Reporting bugs

Open an issue with:

- Chrome version
- Extension version (from `chrome://extensions`)
- Which provider(s) you have configured
- The exact prompt you sent
- What you expected vs what happened
- Console output from the background service worker (`chrome://extensions` → Free Browser Agent → Service worker → Inspect)

---

## License

By contributing you agree that your changes will be licensed under the MIT License.
