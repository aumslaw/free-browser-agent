/**
 * test/ratelimit-daily.test.ts
 *
 * Tests for the RPD (requests per day) and TPD (tokens per day) limits
 * in src/storage/ratelimit.ts, and the UTC day-window reset path.
 *
 * These limits are orthogonal to RPM/TPM — a separate test file keeps them
 * easy to audit. All chrome.storage.local calls are mocked in-memory.
 *
 * Cases covered:
 *   1.  isOverLimit returns false when RPD counter is below limit
 *   2.  isOverLimit returns true when RPD counter equals limit
 *   3.  isOverLimit returns false when rpd limit is 0 (unlimited)
 *   4.  isOverLimit returns false when TPD counter is below limit
 *   5.  isOverLimit returns true when TPD counter exceeds limit
 *   6.  isOverLimit returns false when tpd limit is 0 (unlimited)
 *   7.  RPD counter resets when day_window_start is before UTC midnight
 *   8.  TPD counter resets together with RPD on day rollover
 *   9.  recordRequest increments RPD counter
 *  10.  recordRequest increments TPD counter
 *  11.  getCounters returns rpd + tpd values
 *  12.  isOverLimit: simultaneous RPD + TPD both exceed → still returns true
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// In-memory chrome.storage.local mock
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clearStorage() {
  Object.keys(localStore).forEach((k) => { delete localStore[k]; });
  Object.keys(sessionStore).forEach((k) => { delete sessionStore[k]; });
}

/** Inject a raw RlMap entry directly into storage to set up pre-conditions. */
async function writeRawEntry(
  provider: string,
  model: string,
  keyId: string,
  fields: Partial<{
    rpm: number; rpd: number; tpm: number; tpd: number;
    minute_window_start: number; day_window_start: number; cooldown_until: number;
  }>
): Promise<void> {
  const STORAGE_KEY = "rl";
  const existing = (localStore[STORAGE_KEY] ?? {}) as Record<string, unknown>;
  existing[`${provider}:${model}:${keyId}`] = {
    rpm: 0, rpd: 0, tpm: 0, tpd: 0,
    minute_window_start: Date.now(),
    day_window_start: Date.now(),
    cooldown_until: 0,
    ...fields,
  };
  localStore[STORAGE_KEY] = existing;
}

import {
  isOverLimit,
  recordRequest,
  getCounters,
  resetEntry,
} from "../src/storage/ratelimit.js";

const P = "google" as const;
const M = "gemini-2.0-flash";

// ---------------------------------------------------------------------------
// RPD limits
// ---------------------------------------------------------------------------

describe("isOverLimit — RPD limit", () => {
  beforeEach(clearStorage);

  it("returns false when RPD counter is below limit", async () => {
    const k = `k-${Date.now()}`;
    for (let i = 0; i < 4; i++) await recordRequest(P, M, k, 0);
    expect(await isOverLimit(P, M, k, { rpd: 5 })).toBe(false);
  });

  it("returns true when RPD counter equals the limit", async () => {
    const k = `k-${Date.now()}`;
    for (let i = 0; i < 5; i++) await recordRequest(P, M, k, 0);
    expect(await isOverLimit(P, M, k, { rpd: 5 })).toBe(true);
  });

  it("returns false when rpd limit is 0 (unlimited)", async () => {
    const k = `k-${Date.now()}`;
    for (let i = 0; i < 1000; i++) await recordRequest(P, M, k, 0);
    expect(await isOverLimit(P, M, k, { rpd: 0 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TPD limits
// ---------------------------------------------------------------------------

describe("isOverLimit — TPD limit", () => {
  beforeEach(clearStorage);

  it("returns false when TPD tokens are below the daily limit", async () => {
    const k = `k-${Date.now()}`;
    await recordRequest(P, M, k, 100);
    expect(await isOverLimit(P, M, k, { tpd: 200 })).toBe(false);
  });

  it("returns true when TPD tokens exceed the daily limit", async () => {
    const k = `k-${Date.now()}`;
    await recordRequest(P, M, k, 500);
    expect(await isOverLimit(P, M, k, { tpd: 200 })).toBe(true);
  });

  it("returns false when tpd limit is 0 (unlimited)", async () => {
    const k = `k-${Date.now()}`;
    await recordRequest(P, M, k, 1_000_000);
    expect(await isOverLimit(P, M, k, { tpd: 0 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Day-window rollover (UTC midnight reset)
// ---------------------------------------------------------------------------

describe("day-window rollover — RPD and TPD reset", () => {
  beforeEach(clearStorage);

  it("resets RPD counter after day_window_start crosses UTC midnight", async () => {
    const k = `k-rollover-${Date.now()}`;
    // Write an entry with a day_window_start that is clearly from yesterday
    const yesterday = Date.now() - 25 * 60 * 60 * 1000; // 25h ago
    await writeRawEntry(P, M, k, {
      rpd: 999,     // would be over any limit if not reset
      tpd: 999,
      rpm: 0, tpm: 0,
      minute_window_start: Date.now(),
      day_window_start: yesterday,
      cooldown_until: 0,
    });

    // Should return false: the window has expired, rpd should be treated as 0
    const over = await isOverLimit(P, M, k, { rpd: 5 });
    expect(over).toBe(false);
  });

  it("resets TPD counter together with RPD after day rollover", async () => {
    const k = `k-tpd-rollover-${Date.now()}`;
    const yesterday = Date.now() - 25 * 60 * 60 * 1000;
    await writeRawEntry(P, M, k, {
      rpd: 0, tpd: 9_000_000, rpm: 0, tpm: 0,
      minute_window_start: Date.now(),
      day_window_start: yesterday,
      cooldown_until: 0,
    });

    // tpd was huge but the day window rolled over — should be treated as 0
    expect(await isOverLimit(P, M, k, { tpd: 1_000_000 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// recordRequest increments RPD and TPD
// ---------------------------------------------------------------------------

describe("recordRequest — RPD and TPD increments", () => {
  beforeEach(clearStorage);

  it("increments both rpd and tpd after a request", async () => {
    const k = `k-${Date.now()}`;
    await recordRequest(P, M, k, 123);
    const c = await getCounters(P, M, k);
    expect(c).not.toBeNull();
    expect(c!.rpd).toBe(1);
    expect(c!.tpd).toBe(123);
  });

  it("accumulates rpd across multiple requests within same day", async () => {
    const k = `k-${Date.now()}`;
    await recordRequest(P, M, k, 10);
    await recordRequest(P, M, k, 20);
    await recordRequest(P, M, k, 30);
    const c = await getCounters(P, M, k);
    expect(c!.rpd).toBe(3);
    expect(c!.tpd).toBe(60);
  });

  it("resetEntry clears rpd and tpd", async () => {
    const k = `k-${Date.now()}`;
    await recordRequest(P, M, k, 100);
    await resetEntry(P, M, k);
    expect(await getCounters(P, M, k)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Combined RPD + TPD: both exceeded
// ---------------------------------------------------------------------------

describe("isOverLimit — combined RPD+TPD", () => {
  beforeEach(clearStorage);

  it("returns true when both rpd and tpd are exceeded", async () => {
    const k = `k-${Date.now()}`;
    // 10 requests, 500 tokens each
    for (let i = 0; i < 10; i++) await recordRequest(P, M, k, 500);
    const over = await isOverLimit(P, M, k, { rpd: 5, tpd: 1000 });
    // rpd=10 >= 5 → over
    expect(over).toBe(true);
  });

  it("returns true when only tpd is exceeded (rpd still under)", async () => {
    const k = `k-${Date.now()}`;
    await recordRequest(P, M, k, 9999);
    // rpd=1, tpd=9999
    const over = await isOverLimit(P, M, k, { rpd: 100, tpd: 1000 });
    expect(over).toBe(true);
  });
});
