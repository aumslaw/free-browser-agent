# Contributing to Free Browser Agent

Thanks for your interest. The most useful contributions are:

- **New provider adapters** — any free-tier LLM not yet supported
- **DOM-op improvements** — better content extraction, new action types
- **Bug reports** with reproduction steps
- **Test coverage** for edge cases in router failover or crypto

---

## Dev setup

### Prerequisites

- Node 20+
- pnpm (`npm install -g pnpm`)
- Chrome 122+ for manual extension testing

### Clone and install

```bash
git clone https://github.com/aumslaw/free-browser-agent.git
cd free-browser-agent
pnpm install
```

---

## Build and test commands

### Watch mode (auto-rebuild on save)

```bash
pnpm dev
```

Runs `vite build --watch --mode development`. Every time you save a source file, `dist/` is rebuilt. To see your changes in Chrome:

1. Go to `chrome://extensions`
2. Find **Free Browser Agent** → click the refresh icon (circular arrow)
3. Reload any tab where the content script is active (or close and re-open the side panel)

### Production build

```bash
pnpm build
```

Runs `build.mjs` — a multi-entry Vite build producing:

| Output file | Source |
|---|---|
| `background.js` | `src/background/index.ts` (Service Worker) |
| `content.js` | `src/content/index.ts` |
| `sidepanel.html` + `sidepanel.js` | `src/sidepanel/` (Preact) |
| `options.html` + `options.js` | `src/options/` (Preact) |
| `offscreen.html` + `offscreen.js` | `src/offscreen/offscreen.ts` |

### Type check

```bash
pnpm tsc
```

Runs `tsc --noEmit`. Fix all errors before opening a PR. There should be zero errors on `main`.

### Unit tests

```bash
pnpm test
```

Runs the full Vitest suite (276 tests across 19 files). Tests use jsdom for DOM ops and mock the `chrome.*` extension APIs. No real browser required.

```bash
# Run a single test file
npx vitest run test/router.test.ts

# Run in watch mode
npx vitest
```

### End-to-end tests

```bash
pnpm build && pnpm test:e2e
```

Runs Playwright tests in `test/e2e/`. These load the built extension in a real Chromium instance via Playwright's `--load-extension` flag. Requires `pnpm build` first; Playwright downloads a Chromium binary automatically on first run (`npx playwright install chromium`).

> **Note:** The E2E tests mock the LLM providers — they do not require real API keys. Real-key end-to-end testing requires loading the extension manually in your Chrome profile.

---

## Project layout

```
src/
  background/     — service worker (agent-loop.ts, cdp.ts, index.ts)
  content/        — content script (index.ts, dom-ops.ts)
  offscreen/      — offscreen document for Chrome Prompt API proxy
  onboarding/     — key-acquisition flows (openrouter-oauth.ts, auto-provision.ts)
  providers/      — one file per LLM provider (base.ts + adapters)
  router.ts       — priority failover router with rate-limit ledger
  storage/        — encrypted key storage, rate-limit counters
  sidepanel/      — Preact chat UI
  options/        — Preact settings page
  shared/         — types.ts, tools.ts, message shapes

test/             — unit tests (Vitest + jsdom)
test/e2e/         — Playwright extension tests

docs/
  screenshots/    — placeholder images (real captures pending live E2E run)
```

---

## How to add a new LLM provider

Adding a provider is six steps. The Groq adapter (`src/providers/groq.ts`) is the simplest reference — start there.

### 1. Create the adapter file

Create `src/providers/<name>.ts` extending the abstract `Provider` class from `src/providers/base.ts`:

```ts
import { Provider } from "./base.js";
import type {
  CompletionOptions,
  ChatCompletionResponse,
  ChatCompletionChunk,
} from "./base.js";
import type { ChatMessage } from "@/shared/types.js";

export class MyProvider extends Provider {
  readonly id = "myprovider";           // must be unique; used in rate-limit keys
  readonly name = "My Provider";
  readonly defaultModel = "my-model-id";

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    model: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    // Translate messages + options → provider wire format
    // Return a ChatCompletionResponse (OpenAI-compatible shape)
    // Call this.httpError(status, body) for non-2xx responses so the router
    // can distinguish 429 (rate limit → cooldown + retry) from 4xx (hard error)
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    model: string,
    options?: CompletionOptions,
  ): AsyncIterable<ChatCompletionChunk> {
    // Yield ChatCompletionChunk objects (OpenAI-compatible streaming shape)
    // If the provider doesn't support streaming, fall back to chatCompletion()
    // and emit a single chunk (see src/providers/anthropic.ts for an example)
  }
}
```

### 2. Add the `ProviderId` literal

In `src/shared/types.ts`, add your provider's ID to the `ProviderId` union:

```ts
export type ProviderId =
  | "google" | "groq" | "cerebras" | "openrouter" | "anthropic" | "chrome-ai"
  | "myprovider";   // ← add this
```

### 3. Register in the router

In `src/router.ts`:

- Import your adapter at the top
- Add it to `PROVIDER_INSTANCES`:

```ts
import { MyProvider } from './providers/myprovider.js';

const PROVIDER_INSTANCES = {
  // ... existing providers ...
  myprovider: new MyProvider(),
};
```

- Add rate limits to `PROVIDER_LIMITS`:

```ts
const PROVIDER_LIMITS: Record<ProviderId, { rpm: number; rpd: number; tpm: number; tpd: number }> = {
  // ... existing entries ...
  myprovider: { rpm: 60, rpd: 0, tpm: 0, tpd: 0 },  // adjust to your provider's limits
};
```

- Optionally add to `DEFAULT_PRIORITY` if it should be in the default chain.

### 4. Add a unit test

Create `test/myprovider.test.ts` (or add to `test/router.test.ts`). At minimum, cover:

- Successful `chatCompletion()` call (mock the fetch response)
- 429 rate-limit response → verify the router falls over to the next provider
- Missing/empty API key → verify it's skipped in `buildCandidateList()`

See `test/router.test.ts` for the testing pattern and the `chrome-mock.ts` helper.

### 5. Update the README

Add your provider to the **Supported providers** table in `README.md` with:

- Provider name
- Free-tier limits (req/day or req/min)
- Default model string

### 6. Verify everything

```bash
pnpm tsc && pnpm test && pnpm build
```

All three must pass. Then load the built extension in Chrome and manually test a real API call with your provider's key.

---

## PR conventions

- **One concern per PR.** Provider additions, bug fixes, and feature work in separate PRs.
- **Tests required.** New provider adapters need a unit test. New DOM ops need a jsdom test.
- **No PII in source.** Do not commit API keys, email addresses, or internal endpoint URLs.
- **Type check must pass.** `pnpm tsc` must exit 0.
- **Tests must pass.** `pnpm test` must exit 0 with no skipped tests.

### PR title format

```
feat: add <provider> adapter
fix: handle <error case> in router
refactor: simplify dom-ops scroll
test: cover crypto round-trip edge cases
docs: update quick-start for Linux
```

---

## Reporting bugs

Open a GitHub issue with:

- Chrome version (`chrome://version`)
- Extension version (from `chrome://extensions` → Free Browser Agent)
- Which provider(s) you have configured
- The exact prompt you sent
- What you expected vs. what happened
- Console output from the background Service Worker (`chrome://extensions` → Free Browser Agent → **Service worker** → Inspect → Console tab)

For DOM-op bugs, also include the URL of the page where the issue occurred and any `{escalate:"cdp"}` messages you see in the console.

---

## License

By contributing you agree that your changes will be licensed under the MIT License.
