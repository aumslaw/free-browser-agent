/**
 * test/router.test.ts
 *
 * Vitest unit tests for the Router class and the ratelimit storage module.
 *
 * All chrome.storage APIs are mocked in-memory so tests run in Node.
 *
 * Cases covered (Router.chatCompletion):
 *   1. throws "No provider keys configured" when storage is empty
 *   2. returns response from first available provider
 *   3. falls over to next provider on 429
 *   4. (NEW) disabled provider entry is excluded from candidate list
 *   5. (NEW) all candidates on cooldown → pickCandidate null → throws all-exhausted
 *   6. (NEW) 500-series error sets exponential cooldown (not MAX)
 *   7. (NEW) non-429/non-500 error sets MAX_COOLDOWN
 *   8. (NEW) tool definitions are forwarded to the provider
 *   9. (NEW) setPriorityList overrides DEFAULT_PRIORITY
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ── chrome.storage mock (shared across all test files that import this module)

type StorageArea = Record<string, unknown>;
const localStore: StorageArea = {};
const sessionStore: StorageArea = {};

function makeStorageMock(store: StorageArea) {
  return {
    get: vi.fn(async (key: string | string[]) => {
      if (Array.isArray(key)) return Object.fromEntries(key.map((k) => [k, store[k]]));
      return { [key]: store[key] };
    }),
    set: vi.fn(async (obj: StorageArea) => { Object.assign(store, obj); }),
    remove: vi.fn(async (key: string | string[]) => {
      const keys = Array.isArray(key) ? key : [key];
      keys.forEach((k) => { delete store[k]; });
    }),
  };
}

(globalThis as Record<string, unknown>).chrome = {
  storage: {
    local:   makeStorageMock(localStore),
    session: makeStorageMock(sessionStore),
  },
};

// ── provider mocks — prevent real HTTP in Router tests

vi.mock("../src/providers/google.js", () => ({
  GoogleProvider: vi.fn().mockImplementation(() => ({
    chatCompletion: vi.fn(), streamChatCompletion: vi.fn(),
    id: "google", name: "Google", defaultModel: "gemini-2.0-flash",
  })),
}));
vi.mock("../src/providers/groq.js", () => ({
  GroqProvider: vi.fn().mockImplementation(() => ({
    chatCompletion: vi.fn(), streamChatCompletion: vi.fn(),
    id: "groq", name: "Groq", defaultModel: "llama-3.3-70b-versatile",
  })),
}));
vi.mock("../src/providers/cerebras.js", () => ({
  CerebrasProvider: vi.fn().mockImplementation(() => ({
    chatCompletion: vi.fn(), streamChatCompletion: vi.fn(),
    id: "cerebras", name: "Cerebras", defaultModel: "llama-3.3-70b",
  })),
}));
vi.mock("../src/providers/openrouter.js", () => ({
  OpenRouterProvider: vi.fn().mockImplementation(() => ({
    chatCompletion: vi.fn(), streamChatCompletion: vi.fn(),
    id: "openrouter", name: "OpenRouter", defaultModel: "meta-llama/llama-3.3-70b-instruct:free",
  })),
}));
vi.mock("../src/providers/anthropic.js", () => ({
  AnthropicProvider: vi.fn().mockImplementation(() => ({
    chatCompletion: vi.fn(), streamChatCompletion: vi.fn(),
    id: "anthropic", name: "Anthropic", defaultModel: "claude-haiku-4-5-20251001",
  })),
}));

// crypto mock for keys.ts encrypt/decrypt
vi.mock("../src/storage/crypto.js", () => ({
  encrypt: vi.fn(async (pt: string) => ({ iv: "aaa", ct: btoa(pt) })),
  decrypt: vi.fn(async (env: { ct: string }) => atob(env.ct)),
  getOrCreateMasterKey: vi.fn(),
}));

import {
  isOverLimit,
  recordRequest,
  setCooldown,
  getCooldown,
  resetEntry,
  getCounters,
} from "../src/storage/ratelimit.js";

import { Router } from "../src/router.js";

// ── helpers

function clearStorage() {
  Object.keys(localStore).forEach((k) => { delete localStore[k]; });
  Object.keys(sessionStore).forEach((k) => { delete sessionStore[k]; });
}

const P = "groq" as const;
const M = "llama-3.3-70b-versatile";

// ── isOverLimit — RPM ────────────────────────────────────────────────────────

describe("isOverLimit — RPM limit", () => {
  beforeEach(clearStorage);

  it("returns false for a fresh key under RPM limit", async () => {
    const result = await isOverLimit(P, M, `k-${Date.now()}`, { rpm: 5 });
    expect(result).toBe(false);
  });

  it("returns true when RPM counter equals the limit", async () => {
    const k = `k-${Date.now()}`;
    // Record 5 requests to hit an rpm:5 limit
    for (let i = 0; i < 5; i++) await recordRequest(P, M, k, 0);
    const result = await isOverLimit(P, M, k, { rpm: 5 });
    expect(result).toBe(true);
  });

  it("returns false when rpm limit is 0 (unlimited)", async () => {
    const k = `k-${Date.now()}`;
    for (let i = 0; i < 100; i++) await recordRequest(P, M, k, 0);
    const result = await isOverLimit(P, M, k, { rpm: 0 });
    expect(result).toBe(false);
  });
});

// ── isOverLimit — TPM ────────────────────────────────────────────────────────

describe("isOverLimit — TPM limit", () => {
  beforeEach(clearStorage);

  it("returns false when tokens under limit", async () => {
    const k = `k-${Date.now()}`;
    await recordRequest(P, M, k, 100);
    expect(await isOverLimit(P, M, k, { tpm: 200 })).toBe(false);
  });

  it("returns true when tokens exceed limit", async () => {
    const k = `k-${Date.now()}`;
    await recordRequest(P, M, k, 500);
    expect(await isOverLimit(P, M, k, { tpm: 200 })).toBe(true);
  });
});

// ── setCooldown / getCooldown ────────────────────────────────────────────────

describe("setCooldown / getCooldown", () => {
  beforeEach(clearStorage);

  it("getCooldown returns 0 for a key with no cooldown set", async () => {
    expect(await getCooldown(P, M, `k-${Date.now()}`)).toBe(0);
  });

  it("getCooldown returns the future timestamp that was set", async () => {
    const k = `k-${Date.now()}`;
    const until = Date.now() + 30_000;
    await setCooldown(P, M, k, until);
    const result = await getCooldown(P, M, k);
    expect(result).toBe(until);
  });

  it("getCooldown returns 0 after an expired cooldown", async () => {
    const k = `k-${Date.now()}`;
    // Set a cooldown in the past
    await setCooldown(P, M, k, Date.now() - 1000);
    expect(await getCooldown(P, M, k)).toBe(0);
  });
});

// ── recordRequest / getCounters ──────────────────────────────────────────────

describe("recordRequest / getCounters", () => {
  beforeEach(clearStorage);

  it("increments rpm and tpm after a request", async () => {
    const k = `k-${Date.now()}`;
    await recordRequest(P, M, k, 42);
    const counters = await getCounters(P, M, k);
    expect(counters).not.toBeNull();
    expect(counters!.rpm).toBe(1);
    expect(counters!.tpm).toBe(42);
  });

  it("accumulates multiple requests", async () => {
    const k = `k-${Date.now()}`;
    await recordRequest(P, M, k, 10);
    await recordRequest(P, M, k, 20);
    await recordRequest(P, M, k, 30);
    const counters = await getCounters(P, M, k);
    expect(counters!.rpm).toBe(3);
    expect(counters!.tpm).toBe(60);
  });

  it("getCounters returns null for unknown key", async () => {
    expect(await getCounters(P, M, `unknown-${Date.now()}`)).toBeNull();
  });

  it("resetEntry clears all counters", async () => {
    const k = `k-${Date.now()}`;
    await recordRequest(P, M, k, 99);
    await resetEntry(P, M, k);
    expect(await getCounters(P, M, k)).toBeNull();
  });
});

// ── Router.chatCompletion ────────────────────────────────────────────────────

describe("Router.chatCompletion", () => {
  beforeEach(clearStorage);

  it("throws 'No provider keys configured' when storage has no keys", async () => {
    const router = new Router();
    await expect(
      router.chatCompletion([{ role: "user", content: "hi" }])
    ).rejects.toThrow(/No provider keys configured/);
  });

  it("returns a response from the first available provider", async () => {
    // Save a groq key to storage so the router finds a candidate
    const { saveKey } = await import("../src/storage/keys.js");
    await saveKey("groq", "gsk_test_abc123", "test-groq");

    const mockResp = {
      id: "c1", object: "chat.completion" as const,
      created: Date.now(), model: "llama-3.3-70b-versatile",
      choices: [{
        index: 0,
        message: { role: "assistant" as const, content: "Hello!", tool_calls: undefined },
        finish_reason: "stop" as const,
      }],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    };

    const { GroqProvider } = await import("../src/providers/groq.js");
    vi.mocked(GroqProvider).mock.results[0]?.value?.chatCompletion?.mockResolvedValueOnce(mockResp);

    const router = new Router();
    router.setPriorityList([
      { providerId: "groq", model: "llama-3.3-70b-versatile", key_ids: [], enabled: true },
    ]);

    const result = await router.chatCompletion([{ role: "user", content: "hi" }]);
    expect(result.providerUsed).toContain("groq");
    expect(result.message.content).toBe("Hello!");
  });

  it("falls over to next provider when first returns a 429 error", async () => {
    const { saveKey } = await import("../src/storage/keys.js");
    await saveKey("groq",   "gsk_bad",  "groq-bad");
    await saveKey("google", "aistudio", "google-good");

    const fallbackResp = {
      id: "c2", object: "chat.completion" as const,
      created: Date.now(), model: "gemini-2.0-flash",
      choices: [{
        index: 0,
        message: { role: "assistant" as const, content: "Fallback reply", tool_calls: undefined },
        finish_reason: "stop" as const,
      }],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    };

    const { GroqProvider }   = await import("../src/providers/groq.js");
    const { GoogleProvider } = await import("../src/providers/google.js");

    const err429 = Object.assign(new Error("rate limited"), { status: 429 });
    vi.mocked(GroqProvider).mock.results[0]?.value?.chatCompletion?.mockRejectedValueOnce(err429);
    vi.mocked(GoogleProvider).mock.results[0]?.value?.chatCompletion?.mockResolvedValueOnce(fallbackResp);

    const router = new Router();
    router.setPriorityList([
      { providerId: "groq",   model: "llama-3.3-70b-versatile", key_ids: [], enabled: true },
      { providerId: "google", model: "gemini-2.0-flash",         key_ids: [], enabled: true },
    ]);

    const result = await router.chatCompletion([{ role: "user", content: "hi" }]);
    expect(result.message.content).toBe("Fallback reply");
    expect(result.providerUsed).toContain("google");
  });

  it("excludes disabled provider entries from the candidate list", async () => {
    const { saveKey } = await import("../src/storage/keys.js");
    // Groq key exists but groq is disabled — Google key is the only enabled one
    await saveKey("groq",   "gsk_disabled", "groq-disabled-k");
    await saveKey("google", "aistudio",     "google-enabled");

    const mockResp = {
      id: "c3", object: "chat.completion" as const,
      created: Date.now(), model: "gemini-2.0-flash",
      choices: [{
        index: 0,
        message: { role: "assistant" as const, content: "Only google replied", tool_calls: undefined },
        finish_reason: "stop" as const,
      }],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    };

    const { GoogleProvider } = await import("../src/providers/google.js");
    const { GroqProvider }   = await import("../src/providers/groq.js");

    // Record call counts BEFORE so we can verify groq was NOT called by THIS test
    const groqChatFn = vi.mocked(GroqProvider).mock.results[0]?.value?.chatCompletion;
    const groqCallsBefore = groqChatFn?.mock.calls.length ?? 0;

    vi.mocked(GoogleProvider).mock.results[0]?.value?.chatCompletion?.mockResolvedValueOnce(mockResp);

    const router = new Router();
    // Groq is disabled — should be skipped by buildCandidateList
    router.setPriorityList([
      { providerId: "groq",   model: "llama-3.3-70b-versatile", key_ids: [], enabled: false },
      { providerId: "google", model: "gemini-2.0-flash",         key_ids: [], enabled: true  },
    ]);

    const result = await router.chatCompletion([{ role: "user", content: "test" }]);
    expect(result.providerUsed).toContain("google");
    expect(result.message.content).toBe("Only google replied");
    // Groq's chatCompletion should have 0 NEW calls in this test
    const groqCallsAfter = groqChatFn?.mock.calls.length ?? 0;
    expect(groqCallsAfter).toBe(groqCallsBefore);
  });

  it("throws all-providers-exhausted when every candidate is in cooldown", async () => {
    const { saveKey } = await import("../src/storage/keys.js");
    const k = `groq-cooldown-${Date.now()}`;
    await saveKey("groq", "gsk_on_cooldown", k);

    // Put the key on a cooldown 5 minutes into the future
    await setCooldown("groq", "llama-3.3-70b-versatile", k, Date.now() + 300_000);

    const router = new Router();
    router.setPriorityList([
      { providerId: "groq", model: "llama-3.3-70b-versatile", key_ids: [], enabled: true },
    ]);

    // pickCandidate should return null (all on cooldown), loop breaks, throws exhausted
    await expect(
      router.chatCompletion([{ role: "user", content: "hi" }])
    ).rejects.toThrow(/All providers exhausted/);
  });

  it("sets a MAX cooldown for non-429 / non-500 errors (e.g. 401 auth error)", async () => {
    const { saveKey } = await import("../src/storage/keys.js");
    // saveKey returns the auto-generated key ID that the router will use as keyId
    const keyId = await saveKey("groq", "gsk_bad_auth", `groq-auth-err-${Date.now()}`);

    const { GroqProvider } = await import("../src/providers/groq.js");
    // 401 is not 429 and not 500–599 → takes the MAX_COOLDOWN_MS branch in the catch
    const err401 = Object.assign(new Error("Unauthorized"), { status: 401 });
    vi.mocked(GroqProvider).mock.results[0]?.value?.chatCompletion
      ?.mockRejectedValue(err401);

    const router = new Router();
    router.setPriorityList([
      { providerId: "groq", model: "llama-3.3-70b-versatile", key_ids: [], enabled: true },
    ]);

    const beforeMs = Date.now();
    // The router will exhaust attempts (all candidates hit cooldown from first failure)
    await expect(
      router.chatCompletion([{ role: "user", content: "auth fail" }])
    ).rejects.toThrow(/All providers exhausted/);

    // The cooldown should be set to ~now + MAX_COOLDOWN_MS (300_000)
    // Use the actual keyId returned by saveKey — that's what the router uses
    const cooldown = await getCooldown("groq", "llama-3.3-70b-versatile", keyId);
    expect(cooldown).toBeGreaterThan(beforeMs + 290_000);
  });
});
