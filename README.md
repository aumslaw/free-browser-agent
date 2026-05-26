# Free Browser Agent

**Open-source MV3 browser agent powered by free-tier LLMs — no subscription required.**

Control any webpage with natural language. Ask it to click, fill forms, summarize, or navigate — it figures out the rest, routing your requests across Google Gemini, Groq, Cerebras, and OpenRouter's free models, all from inside a Chrome extension that runs entirely on your machine.

---

## Why this exists

Every AI browser agent worth using is closed-source or locked behind a paid subscription. Free Browser Agent is the open alternative:

- No waitlist, no monthly fee, no proprietary cloud
- Your API keys never leave your browser (encrypted in `chrome.storage.session`, cleared on quit)
- Four free-tier LLM providers with automatic failover — together they give you ~1 billion tokens/month at $0
- Full source available — fork it, audit it, extend it

---

## Screenshots

> Screenshots live in [`docs/screenshots/`](docs/screenshots/) — coming with v0.1.0 release assets.
>
> Short video demo: _(link once recorded)_

---

## Supported providers

| Provider | Free tier | Default models |
|---|---|---|
| **Google Gemini** | 1,500 req/day | `gemini-2.0-flash-lite`, `gemini-1.5-flash` |
| **Groq** | 14,400 req/day | `llama-3.3-70b-versatile`, `llama-3.1-8b-instant` |
| **Cerebras** | 60 req/min | `llama3.1-70b`, `llama3.1-8b` |
| **OpenRouter (free tier)** | varies | `:free` suffix models |

The router tries providers in your configured priority order, automatically backing off on rate limits and retrying the next healthy provider. Every response shows which provider served it.

---

## Quick start

### 1. Clone and build

```bash
git clone https://github.com/aumslaw/free-browser-agent.git
cd free-browser-agent
pnpm install
pnpm build          # outputs dist/
```

`pnpm` is recommended; `npm install && npm run build` works too.

**Requirements:** Node 20+, Chrome 122+

### 2. Load in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `dist/` folder

The Free Browser Agent icon appears in your toolbar.

### 3. Add your API keys

Click the toolbar icon → **Settings** (gear icon), or navigate to the extension's options page.

Paste at least one API key. The extension will route to whichever provider is available and under its rate limit.

### 4. Use it

Click the toolbar icon to open the side panel. Type any instruction:

```
Summarize this page in 3 bullet points
Click the first search result
Fill in the login form with username "demo" and password "demo"
What is the price of the highlighted product?
```

The agent uses your page's DOM to carry out the instruction, falls back to Chrome DevTools Protocol for cross-origin frames or trusted-input fields, and streams the result back to the chat panel.

---

## Get API keys (all free)

| Provider | Sign-up link |
|---|---|
| Google Gemini | https://aistudio.google.com/app/apikey |
| Groq | https://console.groq.com/keys |
| Cerebras | https://cloud.cerebras.ai |
| OpenRouter | https://openrouter.ai/keys |

Each provider's free tier requires an account but no payment method.

---

## Architecture

```
Chrome Extension (MV3)
├── Background Service Worker
│   ├── agent-loop.ts   — LLM ↔ tool-call cycle (max 20 iterations)
│   ├── cdp.ts          — Chrome DevTools Protocol fallback
│   └── index.ts        — message router (side panel / content / options)
│
├── Content Script (all_frames: true)
│   ├── index.ts        — message listener
│   └── dom-ops.ts      — click, type, fillForm, scroll, readPage, waitForSelector
│
├── Providers
│   ├── base.ts         — abstract Provider (chatCompletion / streamChatCompletion)
│   ├── google.ts       — Gemini adapter
│   ├── groq.ts         — Groq adapter
│   ├── cerebras.ts     — Cerebras adapter
│   └── openrouter.ts   — OpenRouter adapter
│
├── Router (router.ts)
│   └── priority-ordered failover, per-key RPM/RPD/TPM/TPD rate-limit ledger
│
├── Storage
│   ├── keys.ts         — list / save / delete provider keys
│   ├── crypto.ts       — AES-256-GCM via WebCrypto; master key in session storage
│   └── ratelimit.ts    — cooldown counters with exponential backoff
│
├── Side Panel (Preact)
│   └── chat UI, streaming render, tool-call inline display, provider badge
│
└── Options Page (Preact)
    └── key management, fallback-chain reorder, connection test
```

### How the agent loop works

1. Your message → background SW
2. SW calls `router.chatCompletion(messages, tools)` — routes to the first healthy provider
3. If the LLM replies with `tool_calls[]`, each call is dispatched:
   - DOM operations → `chrome.tabs.sendMessage` → content script
   - Screenshots, cross-origin clicks, trusted-input events → CDP (`chrome.debugger`)
4. Tool results are appended as `role: "tool"` messages and the loop continues
5. The loop stops when the LLM sends a plain text reply or after 20 iterations
6. Every iteration emits a status update to the side panel for live rendering

### CDP escalation

Some browser actions require elevated access — taking a full screenshot, clicking inside cross-origin iframes, or dispatching events that must be `isTrusted`. When a content-script DOM op returns `{ok: false, escalate: "cdp"}`, the agent loop transparently retries the equivalent action via `chrome.debugger`:

```
DOM op fails with escalate:"cdp"
  → cdp.attach(tabId)
  → Input.dispatchMouseEvent / Page.captureScreenshot / etc.
  → cdp.detach(tabId)
```

### Privacy

- **No telemetry.** Nothing is sent anywhere except the LLM provider you configured.
- **Keys encrypted at rest.** Provider API keys are stored with AES-256-GCM. The master key lives only in `chrome.storage.session` — it is gone when you quit Chrome.
- **Page content stays local.** Page text sent to the LLM is sent directly from your browser to the provider, using your own key, over HTTPS.
- **No extension server.** There is no proxy, no backend, no analytics endpoint. The code is the whole thing.

---

## License

MIT — see [LICENSE](LICENSE).

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
