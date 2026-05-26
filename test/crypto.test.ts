/**
 * test/crypto.test.ts
 * Vitest tests for src/storage/crypto.ts
 *
 * Uses the Node.js built-in WebCrypto implementation (available in Node 18+)
 * to satisfy the crypto.subtle API without a browser.
 * Mocks chrome.storage.session so getOrCreateMasterKey() can persist the JWK.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { webcrypto } from "node:crypto";

// ── polyfill globalThis.crypto with Node webcrypto ───────────────────────────
// Must run before the module import so crypto.subtle is available.
if (!globalThis.crypto) {
  (globalThis as Record<string, unknown>).crypto = webcrypto;
}

// ── mock chrome.storage.session ──────────────────────────────────────────────
// The real chrome namespace is not available in Node. We replicate the minimal
// get/set surface that getOrCreateMasterKey() uses.

const sessionStore: Record<string, unknown> = {};

(globalThis as Record<string, unknown>).chrome = {
  storage: {
    session: {
      get: vi.fn(async (key: string) => ({ [key]: sessionStore[key] })),
      set: vi.fn(async (obj: Record<string, unknown>) => {
        Object.assign(sessionStore, obj);
      }),
    },
    local: {
      get:    vi.fn(async () => ({})),
      set:    vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    },
  },
};

// ── import after polyfills ────────────────────────────────────────────────────
import { encrypt, decrypt, getOrCreateMasterKey } from "../src/storage/crypto.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function clearSession() {
  for (const k of Object.keys(sessionStore)) delete sessionStore[k];
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("getOrCreateMasterKey", () => {
  beforeEach(clearSession);

  it("generates a CryptoKey on first call", async () => {
    const key = await getOrCreateMasterKey();
    expect(key).toBeTruthy();
    expect(key.type).toBe("secret");
    expect(key.algorithm.name).toBe("AES-GCM");
  });

  it("returns the SAME key on second call (persisted in session store)", async () => {
    const k1 = await getOrCreateMasterKey();
    const k2 = await getOrCreateMasterKey();
    // Export both to JWK and compare the key material
    const [j1, j2] = await Promise.all([
      webcrypto.subtle.exportKey("jwk", k1),
      webcrypto.subtle.exportKey("jwk", k2),
    ]);
    expect(j1.k).toBe(j2.k);
  });
});

describe("encrypt / decrypt round-trip", () => {
  beforeEach(clearSession);

  it("round-trips a short ASCII plaintext", async () => {
    const plaintext = "sk-proj-TESTKEY123";
    const envelope = await encrypt(plaintext);
    const recovered = await decrypt(envelope);
    expect(recovered).toBe(plaintext);
  });

  it("round-trips a longer Unicode plaintext", async () => {
    const plaintext = "gsk_aBcDeFgHiJkLmNoPqRsTuVwXyZ_0123456789-emoji-🚀";
    const envelope = await encrypt(plaintext);
    const recovered = await decrypt(envelope);
    expect(recovered).toBe(plaintext);
  });

  it("envelope has non-empty iv and ct fields", async () => {
    const envelope = await encrypt("test");
    expect(typeof envelope.iv).toBe("string");
    expect(typeof envelope.ct).toBe("string");
    expect(envelope.iv.length).toBeGreaterThan(0);
    expect(envelope.ct.length).toBeGreaterThan(0);
  });

  it("IV uniqueness: two encryptions of same plaintext produce different IVs", async () => {
    const e1 = await encrypt("same-plaintext");
    const e2 = await encrypt("same-plaintext");
    expect(e1.iv).not.toBe(e2.iv);
  });

  it("ct is different across two encryptions (different IVs produce different ciphertext)", async () => {
    const e1 = await encrypt("same-plaintext");
    const e2 = await encrypt("same-plaintext");
    expect(e1.ct).not.toBe(e2.ct);
  });

  it("decrypt throws on tampered ciphertext (GCM auth tag failure)", async () => {
    const envelope = await encrypt("tamper-test");
    // Corrupt the last few bytes of the ciphertext
    const ctBytes = Buffer.from(envelope.ct, "base64");
    ctBytes[ctBytes.length - 1] ^= 0xff;
    const tampered = { ...envelope, ct: ctBytes.toString("base64") };
    await expect(decrypt(tampered)).rejects.toThrow();
  });
});
