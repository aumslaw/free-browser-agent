/**
 * storage/keys.ts
 *
 * chrome.storage.local interface for provider API keys.
 *
 * Keys are never stored in plaintext. Each key is encrypted with the session
 * master key (crypto.ts) before being written, and decrypted on read.
 *
 * Storage layout in chrome.storage.local:
 *   {
 *     "keys": {
 *       "<provider>": [
 *         { id, provider, label, envelope: {iv, ct}, created_at },
 *         ...
 *       ]
 *     }
 *   }
 *
 * Multiple keys per provider are supported (e.g., key rotation, multi-key
 * round-robin). The router picks among them via the key_ids list.
 */

import { encrypt, decrypt } from "./crypto";
import type { ProviderId, StoredKey } from "@/shared/types";

// ----- storage key ---------------------------------------------------------

const STORAGE_KEY = "keys";

// ----- internal helpers ----------------------------------------------------

type KeysMap = Record<string, StoredKey[]>;

async function readMap(): Promise<KeysMap> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return (result[STORAGE_KEY] as KeysMap) ?? {};
}

async function writeMap(map: KeysMap): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: map });
}

function makeId(): string {
  return `k_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ----- public API ----------------------------------------------------------

/**
 * Encrypts `key` and appends a new StoredKey record for the given provider.
 * Returns the generated key ID so callers can reference it.
 */
export async function saveKey(
  provider: ProviderId,
  key: string,
  label?: string,
): Promise<string> {
  const envelope = await encrypt(key);
  const id = makeId();

  const map = await readMap();
  const list: StoredKey[] = map[provider] ?? [];

  const record: StoredKey = {
    id,
    provider,
    label: label ?? `${provider}-${id}`,
    envelope,
    created_at: new Date().toISOString(),
  };

  list.push(record);
  map[provider] = list;
  await writeMap(map);

  return id;
}

/**
 * Decrypts and returns the plaintext API key for the given (provider, keyId)
 * pair. Returns null if the key is not found.
 */
export async function getKey(provider: ProviderId, keyId: string): Promise<string | null> {
  const map = await readMap();
  const list: StoredKey[] = map[provider] ?? [];
  const record = list.find((r) => r.id === keyId);
  if (!record) return null;
  return decrypt(record.envelope);
}

/**
 * Returns a summary of all stored keys (one row per key). The plaintext
 * key is never included — only metadata and a `hasKey: true` flag.
 */
export async function listKeys(): Promise<
  { id: string; provider: ProviderId; label: string; created_at: string; hasKey: boolean }[]
> {
  const map = await readMap();
  const results: {
    id: string;
    provider: ProviderId;
    label: string;
    created_at: string;
    hasKey: boolean;
  }[] = [];

  for (const [provider, list] of Object.entries(map)) {
    for (const record of list) {
      results.push({
        id: record.id,
        provider: record.provider,
        label: record.label,
        created_at: record.created_at,
        hasKey: true,
      });
    }
  }

  return results;
}

/**
 * Convenience: returns all key IDs for a given provider.
 * Used by the router when building the candidate list.
 */
export async function getKeyIds(provider: ProviderId): Promise<string[]> {
  const map = await readMap();
  const list: StoredKey[] = map[provider] ?? [];
  return list.map((r) => r.id);
}

/**
 * Permanently removes a stored key. If the keyId is not found the call
 * is a no-op (idempotent).
 */
export async function deleteKey(provider: ProviderId, keyId: string): Promise<void> {
  const map = await readMap();
  const list: StoredKey[] = map[provider] ?? [];
  const filtered = list.filter((r) => r.id !== keyId);
  map[provider] = filtered;
  await writeMap(map);
}


/**
 * Looks up a stored key by its ID across all providers, decrypts it, and
 * returns the plaintext API key string. Throws if the key is not found.
 * Used by the router, which only has a keyId at dispatch time.
 */
export async function getPlaintextKey(keyId: string): Promise<string> {
  const map = await readMap();

  for (const list of Object.values(map)) {
    const record = list.find((r) => r.id === keyId);
    if (record) {
      return decrypt(record.envelope);
    }
  }

  throw new Error();
}

/**
 * Removes ALL keys for every provider. Used by the settings "clear all" flow.
 */
export async function clearAllKeys(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}
