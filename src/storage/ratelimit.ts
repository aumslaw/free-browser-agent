/**
 * storage/ratelimit.ts
 *
 * Per-key rate-limit counters persisted to chrome.storage.local.
 *
 * Counter semantics:
 *   RPM (requests per minute) — sliding 60-second window
 *   RPD (requests per day)    — rolling UTC calendar day (resets at midnight)
 *   TPM (tokens per minute)   — sliding 60-second window
 *   TPD (tokens per day)      — rolling UTC calendar day
 *
 * Additionally each (provider, model, keyId) triple can have a
 * `cooldown_until` timestamp set when a 429 / 5xx is received. The router
 * checks this before attempting a request.
 *
 * Storage layout in chrome.storage.local:
 *   {
 *     "rl": {
 *       "<provider>:<model>:<keyId>": {
 *         rpm: number,           // requests in current minute window
 *         rpd: number,           // requests in current UTC day
 *         tpm: number,           // tokens in current minute window
 *         tpd: number,           // tokens in current UTC day
 *         minute_window_start: number,  // unix-ms of current minute window start
 *         day_window_start: number,     // unix-ms of UTC midnight that opened the day window
 *         cooldown_until: number,       // unix-ms; 0 = no cooldown
 *       }
 *     }
 *   }
 */

import type { ProviderId } from "@/shared/types";

// ----- constants -----------------------------------------------------------

const STORAGE_KEY = "rl";
const MINUTE_MS = 60_000;

// ----- types ---------------------------------------------------------------

interface RlEntry {
  rpm: number;
  rpd: number;
  tpm: number;
  tpd: number;
  minute_window_start: number;
  day_window_start: number;
  cooldown_until: number;
}

type RlMap = Record<string, RlEntry>;

export interface RateLimits {
  rpm?: number;
  rpd?: number;
  tpm?: number;
  tpd?: number;
}

// ----- helpers -------------------------------------------------------------

function entryKey(provider: ProviderId, model: string, keyId: string): string {
  return `${provider}:${model}:${keyId}`;
}

async function readMap(): Promise<RlMap> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return (result[STORAGE_KEY] as RlMap) ?? {};
}

async function writeMap(map: RlMap): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: map });
}

/**
 * Returns the unix-ms timestamp of the UTC midnight that started the current
 * calendar day.
 */
function utcMidnightMs(nowMs: number = Date.now()): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Reads the entry for (provider, model, keyId), applying window resets as
 * needed. Does NOT write back — callers must call `writeMap` after mutations.
 */
function resolveEntry(map: RlMap, key: string, nowMs: number): RlEntry {
  const existing = map[key];

  const midnight = utcMidnightMs(nowMs);

  if (!existing) {
    return {
      rpm: 0,
      rpd: 0,
      tpm: 0,
      tpd: 0,
      minute_window_start: nowMs,
      day_window_start: midnight,
      cooldown_until: 0,
    };
  }

  // Reset minute window if 60+ seconds have elapsed
  const minuteExpired = nowMs - existing.minute_window_start >= MINUTE_MS;
  // Reset day window if we've crossed a UTC midnight
  const dayExpired = existing.day_window_start < midnight;

  return {
    rpm: minuteExpired ? 0 : existing.rpm,
    rpd: dayExpired ? 0 : existing.rpd,
    tpm: minuteExpired ? 0 : existing.tpm,
    tpd: dayExpired ? 0 : existing.tpd,
    minute_window_start: minuteExpired ? nowMs : existing.minute_window_start,
    day_window_start: dayExpired ? midnight : existing.day_window_start,
    cooldown_until: existing.cooldown_until,
  };
}

// ----- public API ----------------------------------------------------------

/**
 * Records a completed request, incrementing RPM, RPD, TPM, TPD counters.
 * `tokens` should be the total tokens consumed (prompt + completion).
 * Pass 0 if token count is unavailable.
 */
export async function recordRequest(
  provider: ProviderId,
  model: string,
  keyId: string,
  tokens: number,
): Promise<void> {
  const nowMs = Date.now();
  const k = entryKey(provider, model, keyId);

  const map = await readMap();
  const entry = resolveEntry(map, k, nowMs);

  entry.rpm += 1;
  entry.rpd += 1;
  entry.tpm += tokens;
  entry.tpd += tokens;

  map[k] = entry;
  await writeMap(map);
}

/**
 * Returns true if the key is currently over any of its configured limits.
 * Any limit set to 0 (or omitted) means "unlimited" for that dimension.
 */
export async function isOverLimit(
  provider: ProviderId,
  model: string,
  keyId: string,
  limits: RateLimits,
): Promise<boolean> {
  const nowMs = Date.now();
  const k = entryKey(provider, model, keyId);

  const map = await readMap();
  const entry = resolveEntry(map, k, nowMs);

  const { rpm = 0, rpd = 0, tpm = 0, tpd = 0 } = limits;

  if (rpm > 0 && entry.rpm >= rpm) return true;
  if (rpd > 0 && entry.rpd >= rpd) return true;
  if (tpm > 0 && entry.tpm >= tpm) return true;
  if (tpd > 0 && entry.tpd >= tpd) return true;

  return false;
}

/**
 * Sets a cooldown on a key until `untilMs` (unix-ms).
 * Used by the router after receiving a 429 or repeated 5xx responses.
 */
export async function setCooldown(
  provider: ProviderId,
  model: string,
  keyId: string,
  untilMs: number,
): Promise<void> {
  const k = entryKey(provider, model, keyId);
  const map = await readMap();
  const entry = resolveEntry(map, k, Date.now());

  entry.cooldown_until = untilMs;
  map[k] = entry;
  await writeMap(map);
}

/**
 * Returns the `cooldown_until` unix-ms for the key.
 * Returns 0 if no cooldown is set or if the cooldown has already expired.
 */
export async function getCooldown(
  provider: ProviderId,
  model: string,
  keyId: string,
): Promise<number> {
  const nowMs = Date.now();
  const k = entryKey(provider, model, keyId);

  const map = await readMap();
  const existing = map[k];

  if (!existing) return 0;

  // Auto-clear expired cooldowns
  if (existing.cooldown_until > 0 && existing.cooldown_until <= nowMs) {
    const entry = resolveEntry(map, k, nowMs);
    entry.cooldown_until = 0;
    map[k] = entry;
    // Fire-and-forget — no need to await in a read path
    writeMap(map).catch(() => {
      // Ignore write errors on cleanup path
    });
    return 0;
  }

  return existing.cooldown_until;
}

/**
 * Resets all rate-limit counters and clears any cooldown for the given key.
 * Useful for testing or when a user manually resets a key.
 */
export async function resetEntry(
  provider: ProviderId,
  model: string,
  keyId: string,
): Promise<void> {
  const k = entryKey(provider, model, keyId);
  const map = await readMap();
  delete map[k];
  await writeMap(map);
}

/**
 * Returns the current (window-adjusted) counter snapshot for a key.
 * Returns null if no data has been recorded yet.
 */
export async function getCounters(
  provider: ProviderId,
  model: string,
  keyId: string,
): Promise<{
  rpm: number;
  rpd: number;
  tpm: number;
  tpd: number;
  cooldown_until: number;
} | null> {
  const k = entryKey(provider, model, keyId);
  const map = await readMap();

  if (!map[k]) return null;

  const entry = resolveEntry(map, k, Date.now());
  return {
    rpm: entry.rpm,
    rpd: entry.rpd,
    tpm: entry.tpm,
    tpd: entry.tpd,
    cooldown_until: entry.cooldown_until,
  };
}
