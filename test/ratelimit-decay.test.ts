/**
 * test/ratelimit-decay.test.ts
 *
 * Tests for time-based window-reset behaviour in src/storage/ratelimit.ts.
 *
 * Uses vi.useFakeTimers() / vi.setSystemTime() to simulate:
 *   1. 60-second RPM window expiry — counters reset, new window opens
 *   2. RPM window NOT expired at 59 seconds — counters still accumulate
 *   3. UTC midnight crossing — RPD/TPD counters reset, RPM/TPM carry over
 *   4. UTC midnight NOT crossed — RPD counter does NOT reset
 *   5. Cooldown auto-clears when the cooldown timestamp is in the past
 *   6. Cooldown is preserved when timestamp is in the future
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── chrome.storage mock ──────────────────────────────────────────────────────

type StorageArea = Record<string, unknown>;
const localStore: StorageArea = {};

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
    local: makeStorageMock(localStore),
    session: makeStorageMock({}),
  },
};

// ── helpers ──────────────────────────────────────────────────────────────────

function clearStorage() {
  Object.keys(localStore).forEach((k) => { delete localStore[k]; });
}

// ── imports (after globalThis.chrome is set) ─────────────────────────────────

import {
  recordRequest,
  isOverLimit,
  getCounters,
  setCooldown,
  getCooldown,
} from "../src/storage/ratelimit.js";

const P = "groq" as const;
const M = "llama-3.3-70b-versatile";

// ── 60-second window expiry ──────────────────────────────────────────────────

describe("ratelimit — 60-second RPM/TPM window expiry", () => {
  beforeEach(() => {
    clearStorage();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("RPM counter resets to 0 after 60+ seconds elapse", async () => {
    const k = "k-rpm-decay";

    // Record 5 requests at T=0
    vi.setSystemTime(new Date("2026-05-26T12:00:00.000Z"));
    for (let i = 0; i < 5; i++) await recordRequest(P, M, k, 10);

    const before = await getCounters(P, M, k);
    expect(before!.rpm).toBe(5);
    expect(before!.tpm).toBe(50);

    // Advance 61 seconds — window should have expired
    vi.setSystemTime(new Date("2026-05-26T12:01:01.000Z"));

    const after = await getCounters(P, M, k);
    expect(after!.rpm).toBe(0);
    expect(after!.tpm).toBe(0);
  });

  it("RPM counter does NOT reset at 59 seconds (window still open)", async () => {
    const k = "k-rpm-nodecay";

    vi.setSystemTime(new Date("2026-05-26T12:00:00.000Z"));
    for (let i = 0; i < 3; i++) await recordRequest(P, M, k, 20);

    // Advance only 59 seconds
    vi.setSystemTime(new Date("2026-05-26T12:00:59.000Z"));

    const counters = await getCounters(P, M, k);
    expect(counters!.rpm).toBe(3);
    expect(counters!.tpm).toBe(60);
  });

  it("isOverLimit returns false after window expires even when rpm limit was met", async () => {
    const k = "k-rpm-limit-expire";

    vi.setSystemTime(new Date("2026-05-26T12:00:00.000Z"));
    // Hit an rpm:3 limit
    for (let i = 0; i < 3; i++) await recordRequest(P, M, k, 0);

    expect(await isOverLimit(P, M, k, { rpm: 3 })).toBe(true);

    // Advance past the window
    vi.setSystemTime(new Date("2026-05-26T12:01:01.000Z"));

    expect(await isOverLimit(P, M, k, { rpm: 3 })).toBe(false);
  });

  it("RPM counter accumulates new requests after a window reset", async () => {
    const k = "k-rpm-new-window";

    vi.setSystemTime(new Date("2026-05-26T12:00:00.000Z"));
    for (let i = 0; i < 4; i++) await recordRequest(P, M, k, 5);

    vi.setSystemTime(new Date("2026-05-26T12:01:05.000Z"));
    // Record 2 new requests in the new window
    await recordRequest(P, M, k, 100);
    await recordRequest(P, M, k, 100);

    const counters = await getCounters(P, M, k);
    // Only the 2 new-window requests should count
    expect(counters!.rpm).toBe(2);
    expect(counters!.tpm).toBe(200);
  });
});

// ── UTC midnight RPD/TPD reset ────────────────────────────────────────────────

describe("ratelimit — UTC midnight RPD/TPD day-window reset", () => {
  beforeEach(() => {
    clearStorage();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("RPD counter resets to 0 when UTC midnight is crossed", async () => {
    const k = "k-rpd-decay";

    // Record 10 requests during one UTC day (May 25)
    vi.setSystemTime(new Date("2026-05-25T23:59:00.000Z"));
    for (let i = 0; i < 10; i++) await recordRequest(P, M, k, 50);

    const before = await getCounters(P, M, k);
    expect(before!.rpd).toBe(10);

    // Cross midnight into May 26
    vi.setSystemTime(new Date("2026-05-26T00:00:01.000Z"));

    const after = await getCounters(P, M, k);
    expect(after!.rpd).toBe(0);
    expect(after!.tpd).toBe(0);
  });

  it("RPD counter does NOT reset before UTC midnight", async () => {
    const k = "k-rpd-nodecay";

    vi.setSystemTime(new Date("2026-05-26T08:00:00.000Z"));
    for (let i = 0; i < 7; i++) await recordRequest(P, M, k, 10);

    // 1 hour later — still the same UTC day
    vi.setSystemTime(new Date("2026-05-26T09:00:00.000Z"));

    const counters = await getCounters(P, M, k);
    expect(counters!.rpd).toBe(7);
  });

  it("isOverLimit reflects RPD reset after midnight crossing", async () => {
    const k = "k-rpd-limit";

    vi.setSystemTime(new Date("2026-05-25T22:00:00.000Z"));
    for (let i = 0; i < 5; i++) await recordRequest(P, M, k, 0);

    expect(await isOverLimit(P, M, k, { rpd: 5 })).toBe(true);

    // Cross midnight
    vi.setSystemTime(new Date("2026-05-26T00:00:00.001Z"));

    expect(await isOverLimit(P, M, k, { rpd: 5 })).toBe(false);
  });
});

// ── cooldown auto-clear ───────────────────────────────────────────────────────

describe("ratelimit — cooldown auto-clear on expiry", () => {
  beforeEach(() => {
    clearStorage();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("getCooldown returns 0 when the stored cooldown timestamp is in the past", async () => {
    const k = "k-cooldown-past";
    vi.setSystemTime(new Date("2026-05-26T12:00:00.000Z"));

    // Set a cooldown that expires 30 seconds in the future
    const expiry = Date.now() + 30_000;
    await setCooldown(P, M, k, expiry);

    // Verify it's set
    expect(await getCooldown(P, M, k)).toBe(expiry);

    // Advance past the expiry
    vi.setSystemTime(new Date("2026-05-26T12:00:31.000Z"));

    // Should auto-clear and return 0
    expect(await getCooldown(P, M, k)).toBe(0);
  });

  it("getCooldown returns the future timestamp when cooldown is still active", async () => {
    const k = "k-cooldown-active";
    vi.setSystemTime(new Date("2026-05-26T12:00:00.000Z"));

    const expiry = Date.now() + 60_000;
    await setCooldown(P, M, k, expiry);

    // Only advance 10 seconds — cooldown is still active
    vi.setSystemTime(new Date("2026-05-26T12:00:10.000Z"));

    expect(await getCooldown(P, M, k)).toBe(expiry);
  });
});
