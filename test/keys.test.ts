/**
 * test/keys.test.ts
 *
 * Unit tests for src/storage/keys.ts.
 * Mocks chrome.storage.local (in-memory) and crypto.subtle (passthrough encrypt/decrypt).
 *
 * Tests cover:
 *   1. saveKey() stores an encrypted record and returns a generated id
 *   2. saveKey() with an explicit label uses that label
 *   3. saveKey() appends to an existing list (multiple keys per provider)
 *   4. getKey() returns the decrypted plaintext for a known (provider, keyId)
 *   5. getKey() returns null when keyId is not found
 *   6. listKeys() returns one row per key with hasKey:true and no plaintext
 *   7. getKeyIds() returns only ids for the requested provider
 *   8. deleteKey() removes the targeted key, leaves others untouched
 *   9. deleteKey() is idempotent when key does not exist
 *  10. getPlaintextKey() finds a key across providers by id
 *  11. getPlaintextKey() throws when key is not found
 *  12. clearAllKeys() removes all keys from storage
 *  13. tools.ts: getToolByName() returns correct tool definition
 *  14. tools.ts: CDP_ONLY_TOOLS and CONTENT_FIRST_TOOLS cover correct names
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Minimal Web Crypto mock — deterministic encrypt/decrypt (iv = zeros)
// We use a simple XOR-based pseudo-cipher so encrypt/decrypt roundtrips work
// without a real SubtleCrypto environment.
// ---------------------------------------------------------------------------

const enc = new TextEncoder();
const dec = new TextDecoder();

// A 256-bit key used by the mock
const MOCK_KEY_BYTES = new Uint8Array(32).fill(0x42);

// Fake EncryptedEnvelope: just base64(plaintext) + ":" + base64(iv)
function fakeEncrypt(text: string): { iv: string; ct: string } {
  const bytes = enc.encode(text);
  return {
    iv: btoa(String.fromCharCode(...new Uint8Array(12).fill(0))),
    ct: btoa(String.fromCharCode(...bytes)),
  };
}

function fakeDecrypt(envelope: { iv: string; ct: string }): string {
  const bytes = Uint8Array.from(atob(envelope.ct), c => c.charCodeAt(0));
  return dec.decode(bytes);
}

// ---------------------------------------------------------------------------
// Mock crypto module before importing keys.ts
// ---------------------------------------------------------------------------

vi.mock("../src/storage/crypto.js", () => ({
  encrypt: vi.fn().mockImplementation((text: string) => Promise.resolve(fakeEncrypt(text))),
  decrypt: vi.fn().mockImplementation((env: { iv: string; ct: string }) =>
    Promise.resolve(fakeDecrypt(env))
  ),
}));

// ---------------------------------------------------------------------------
// chrome.storage mock
// ---------------------------------------------------------------------------

type StorageArea = Record<string, unknown>;
const localStore: StorageArea = {};

(globalThis as Record<string, unknown>).chrome = {
  storage: {
    local: {
      get: vi.fn().mockImplementation(async (key: string | string[]) => {
        if (Array.isArray(key)) {
          return Object.fromEntries(key.map(k => [k, localStore[k]]));
        }
        return { [key]: localStore[key] };
      }),
      set: vi.fn().mockImplementation(async (obj: StorageArea) => {
        Object.assign(localStore, obj);
      }),
      remove: vi.fn().mockImplementation(async (key: string | string[]) => {
        const keys = Array.isArray(key) ? key : [key];
        keys.forEach(k => { delete localStore[k]; });
      }),
    },
  },
};

function clearStorage() {
  Object.keys(localStore).forEach(k => { delete localStore[k]; });
}

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import {
  saveKey,
  getKey,
  listKeys,
  getKeyIds,
  deleteKey,
  getPlaintextKey,
  clearAllKeys,
} from "../src/storage/keys.js";

import {
  getToolByName,
  CDP_ONLY_TOOLS,
  CONTENT_FIRST_TOOLS,
  AGENT_TOOLS,
} from "../src/shared/tools.js";

// ---------------------------------------------------------------------------
// Tests — keys.ts
// ---------------------------------------------------------------------------

describe("saveKey / getKey roundtrip", () => {
  beforeEach(clearStorage);

  it("saveKey returns a generated key id and getKey returns the original plaintext", async () => {
    const id = await saveKey("groq", "sk-groq-secret-123");
    expect(typeof id).toBe("string");
    expect(id.startsWith("k_")).toBe(true);

    const plaintext = await getKey("groq", id);
    expect(plaintext).toBe("sk-groq-secret-123");
  });

  it("saveKey with explicit label stores that label", async () => {
    const id = await saveKey("groq", "sk-test", "my-label");
    const keys = await listKeys();
    const row = keys.find(k => k.id === id);
    expect(row?.label).toBe("my-label");
  });

  it("saveKey uses default label '<provider>-<id>' when no label provided", async () => {
    const id = await saveKey("cerebras", "sk-cerebras-abc");
    const keys = await listKeys();
    const row = keys.find(k => k.id === id);
    expect(row?.label).toBe(`cerebras-${id}`);
  });

  it("supports multiple keys per provider — both are retrievable", async () => {
    const id1 = await saveKey("groq", "sk-groq-1");
    const id2 = await saveKey("groq", "sk-groq-2");

    expect(await getKey("groq", id1)).toBe("sk-groq-1");
    expect(await getKey("groq", id2)).toBe("sk-groq-2");
  });
});

describe("getKey edge cases", () => {
  beforeEach(clearStorage);

  it("returns null when keyId is not found", async () => {
    await saveKey("groq", "sk-groq");
    const result = await getKey("groq", "k_nonexistent_id");
    expect(result).toBeNull();
  });

  it("returns null when provider has no keys at all", async () => {
    const result = await getKey("google", "k_whatever");
    expect(result).toBeNull();
  });
});

describe("listKeys", () => {
  beforeEach(clearStorage);

  it("returns one row per key with hasKey:true and no plaintext field", async () => {
    const id1 = await saveKey("groq", "sk-groq-1", "groq-prod");
    const id2 = await saveKey("google", "sk-google-1", "google-dev");

    const keys = await listKeys();
    expect(keys).toHaveLength(2);

    const groqRow = keys.find(k => k.id === id1);
    expect(groqRow?.provider).toBe("groq");
    expect(groqRow?.label).toBe("groq-prod");
    expect(groqRow?.hasKey).toBe(true);
    expect((groqRow as Record<string, unknown>).plaintext).toBeUndefined();

    const googleRow = keys.find(k => k.id === id2);
    expect(googleRow?.provider).toBe("google");
  });

  it("returns empty array when no keys stored", async () => {
    const keys = await listKeys();
    expect(keys).toHaveLength(0);
  });
});

describe("getKeyIds", () => {
  beforeEach(clearStorage);

  it("returns only the ids for the requested provider", async () => {
    const id1 = await saveKey("groq", "sk-groq-1");
    const id2 = await saveKey("groq", "sk-groq-2");
    await saveKey("cerebras", "sk-cerebras");

    const groqIds = await getKeyIds("groq");
    expect(groqIds).toHaveLength(2);
    expect(groqIds).toContain(id1);
    expect(groqIds).toContain(id2);

    const cerebrasIds = await getKeyIds("cerebras");
    expect(cerebrasIds).toHaveLength(1);
  });

  it("returns empty array when provider has no keys", async () => {
    const ids = await getKeyIds("openrouter");
    expect(ids).toHaveLength(0);
  });
});

describe("deleteKey", () => {
  beforeEach(clearStorage);

  it("removes the targeted key and leaves other keys for the same provider", async () => {
    const id1 = await saveKey("groq", "sk-groq-1");
    const id2 = await saveKey("groq", "sk-groq-2");

    await deleteKey("groq", id1);

    expect(await getKey("groq", id1)).toBeNull();
    expect(await getKey("groq", id2)).toBe("sk-groq-2");
  });

  it("is idempotent — does not throw when key does not exist", async () => {
    await saveKey("groq", "sk-groq");
    await expect(deleteKey("groq", "k_nonexistent")).resolves.toBeUndefined();
  });
});

describe("getPlaintextKey", () => {
  beforeEach(clearStorage);

  it("finds a key across providers by its id", async () => {
    await saveKey("groq", "sk-groq");
    const googleId = await saveKey("google", "sk-google-secret");

    const plaintext = await getPlaintextKey(googleId);
    expect(plaintext).toBe("sk-google-secret");
  });

  it("throws when the key is not found", async () => {
    await expect(getPlaintextKey("k_nonexistent")).rejects.toThrow();
  });
});

describe("clearAllKeys", () => {
  beforeEach(clearStorage);

  it("removes all keys so listKeys returns empty", async () => {
    await saveKey("groq", "sk-1");
    await saveKey("google", "sk-2");

    await clearAllKeys();

    const keys = await listKeys();
    expect(keys).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests — tools.ts (pure data + lookup functions)
// ---------------------------------------------------------------------------

describe("tools.ts — getToolByName", () => {
  it("returns the correct tool definition for a known name", () => {
    const clickTool = getToolByName("click");
    expect(clickTool).toBeDefined();
    expect(clickTool!.type).toBe("function");
    expect(clickTool!.function.name).toBe("click");
    expect(clickTool!.function.parameters.required).toContain("selector");
  });

  it("returns undefined for an unknown tool name", () => {
    expect(getToolByName("nonexistent")).toBeUndefined();
  });

  it("returns screenshot tool (last in array)", () => {
    const tool = getToolByName("screenshot");
    expect(tool).toBeDefined();
    expect(tool!.function.parameters.properties).toHaveProperty("quality");
    expect(tool!.function.parameters.properties).toHaveProperty("format");
  });
});

describe("tools.ts — CDP_ONLY_TOOLS and CONTENT_FIRST_TOOLS", () => {
  it("CDP_ONLY_TOOLS contains 'screenshot' and nothing else", () => {
    expect(CDP_ONLY_TOOLS.has("screenshot")).toBe(true);
    expect(CDP_ONLY_TOOLS.size).toBe(1);
  });

  it("CONTENT_FIRST_TOOLS contains all non-CDP tool names", () => {
    expect(CONTENT_FIRST_TOOLS.has("click")).toBe(true);
    expect(CONTENT_FIRST_TOOLS.has("type")).toBe(true);
    expect(CONTENT_FIRST_TOOLS.has("fillForm")).toBe(true);
    expect(CONTENT_FIRST_TOOLS.has("scroll")).toBe(true);
    expect(CONTENT_FIRST_TOOLS.has("readPage")).toBe(true);
    expect(CONTENT_FIRST_TOOLS.has("getUrl")).toBe(true);
    expect(CONTENT_FIRST_TOOLS.has("getSelection")).toBe(true);
    expect(CONTENT_FIRST_TOOLS.has("waitForSelector")).toBe(true);
    // screenshot is CDP-only — should NOT be in CONTENT_FIRST
    expect(CONTENT_FIRST_TOOLS.has("screenshot")).toBe(false);
  });

  it("every AGENT_TOOLS entry is in exactly one of the two sets", () => {
    for (const tool of AGENT_TOOLS) {
      const name = tool.function.name;
      const inCdpOnly = CDP_ONLY_TOOLS.has(name);
      const inContentFirst = CONTENT_FIRST_TOOLS.has(name);
      // Each tool must be in exactly one set (XOR)
      expect(inCdpOnly !== inContentFirst).toBe(true);
    }
  });
});
