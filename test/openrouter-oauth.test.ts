/**
 * test/openrouter-oauth.test.ts
 *
 * Unit tests for src/onboarding/openrouter-oauth.ts.
 *
 * Tested:
 *  1. generatePkcePair() -- verifier is 43-128 chars, URL-safe
 *  2. generatePkcePair() -- challenge equals base64url(SHA-256(verifier)), recomputed
 *  3. parseCodeFromRedirect() -- extracts code param from a valid redirect URL
 *  4. parseCodeFromRedirect() -- returns null when code is absent
 *  5. parseCodeFromRedirect() -- returns null for a malformed URL
 *  6. connectOpenRouter() -- returns { ok: true, keyId } on successful exchange
 *  7. connectOpenRouter() -- returns { ok: false, error } on a 400 from token endpoint
 *  8. connectOpenRouter() -- returns { ok: false, error } when chrome.identity throws
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { webcrypto } from "node:crypto";

// ---------------------------------------------------------------------------
// Polyfill Web Crypto (Node 18+ webcrypto is the real implementation)
// ---------------------------------------------------------------------------
if (!globalThis.crypto) {
  (globalThis as Record<string, unknown>).crypto = webcrypto;
} else {
  if (!(globalThis.crypto as Crypto).subtle) {
    (globalThis.crypto as unknown as Record<string, unknown>).subtle = webcrypto.subtle;
  }
}

// ---------------------------------------------------------------------------
// Mock chrome.identity and chrome.storage (needed by saveKey inside the flow)
// ---------------------------------------------------------------------------

const localStore: Record<string, unknown> = {};

(globalThis as Record<string, unknown>).chrome = {
  identity: {
    getRedirectURL: vi.fn(() => "https://abc.chromiumapp.org/"),
    launchWebAuthFlow: vi.fn(),
  },
  storage: {
    local: {
      get: vi.fn(async (key: string) => ({ [key]: localStore[key] })),
      set: vi.fn(async (obj: Record<string, unknown>) => {
        Object.assign(localStore, obj);
      }),
      remove: vi.fn(async () => {}),
    },
    session: {
      get: vi.fn(async (key: string) => ({ [key]: undefined })),
      set: vi.fn(async () => {}),
    },
  },
};

function clearStorage() {
  for (const k of Object.keys(localStore)) delete localStore[k];
}

// ---------------------------------------------------------------------------
// Mock the crypto module used by keys.ts (encrypt/decrypt)
// ---------------------------------------------------------------------------

vi.mock("../src/storage/crypto.js", () => ({
  encrypt: vi.fn(async (text: string) => ({
    iv: btoa("000000000000"),
    ct: btoa(text),
  })),
  decrypt: vi.fn(async (env: { iv: string; ct: string }) => atob(env.ct)),
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import {
  generatePkcePair,
  parseCodeFromRedirect,
  connectOpenRouter,
} from "../src/onboarding/openrouter-oauth.js";

// ---------------------------------------------------------------------------
// Helper: recompute challenge from verifier using the same algorithm
// ---------------------------------------------------------------------------

async function recomputeChallenge(verifier: string): Promise<string> {
  const encoded = new TextEncoder().encode(verifier);
  const digest = await (globalThis.crypto as Crypto).subtle.digest("SHA-256", encoded);
  const bytes = new Uint8Array(digest);
  let bin = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("generatePkcePair", () => {
  it("produces a verifier between 43 and 128 characters", async () => {
    const { verifier } = await generatePkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
  });

  it("verifier contains only URL-safe characters", async () => {
    const { verifier } = await generatePkcePair();
    expect(/^[A-Za-z0-9\-._~]+$/.test(verifier)).toBe(true);
  });

  it("challenge equals base64url(SHA-256(verifier)) verified by recomputing", async () => {
    const { verifier, challenge } = await generatePkcePair();
    const expected = await recomputeChallenge(verifier);
    expect(challenge).toBe(expected);
  });

  it("challenge contains no base64 padding or forbidden chars", async () => {
    const { challenge } = await generatePkcePair();
    expect(challenge).not.toContain("=");
    expect(challenge).not.toContain("+");
    expect(challenge).not.toContain("/");
  });

  it("two calls produce different verifiers", async () => {
    const { verifier: v1 } = await generatePkcePair();
    const { verifier: v2 } = await generatePkcePair();
    expect(v1).not.toBe(v2);
  });
});

describe("parseCodeFromRedirect", () => {
  it("extracts the code param from a standard redirect URL", () => {
    const code = parseCodeFromRedirect(
      "https://abc.chromiumapp.org/?code=XYZ123&state=foo"
    );
    expect(code).toBe("XYZ123");
  });

  it("returns null when the code param is absent", () => {
    const code = parseCodeFromRedirect(
      "https://abc.chromiumapp.org/?state=foo&error=access_denied"
    );
    expect(code).toBeNull();
  });

  it("returns null for a malformed URL", () => {
    const code = parseCodeFromRedirect("not-a-url");
    expect(code).toBeNull();
  });

  it("handles a redirect URL with only the code param", () => {
    const code = parseCodeFromRedirect(
      "https://xyz.chromiumapp.org/?code=AUTHCODE_ABC"
    );
    expect(code).toBe("AUTHCODE_ABC");
  });
});

describe("connectOpenRouter", () => {
  beforeEach(() => {
    clearStorage();
    vi.clearAllMocks();
    (chrome.identity.getRedirectURL as ReturnType<typeof vi.fn>).mockReturnValue(
      "https://abc.chromiumapp.org/"
    );
  });

  it("returns { ok: true, keyId } on a successful exchange", async () => {
    (chrome.identity.launchWebAuthFlow as ReturnType<typeof vi.fn>).mockResolvedValue(
      "https://abc.chromiumapp.org/?code=AUTH_CODE_XYZ"
    );

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ key: "sk-or-user-abc123" }),
      text: async () => "",
    } as Response);

    const result = await connectOpenRouter();

    expect(result.ok).toBe(true);
    expect(typeof result.keyId).toBe("string");
    expect(result.keyId!.startsWith("k_")).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("posts the correct body to the token endpoint", async () => {
    (chrome.identity.launchWebAuthFlow as ReturnType<typeof vi.fn>).mockResolvedValue(
      "https://abc.chromiumapp.org/?code=MY_CODE"
    );

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ key: "sk-or-user-test" }),
      text: async () => "",
    } as Response);
    globalThis.fetch = mockFetch;

    await connectOpenRouter();

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/auth/keys");
    expect(init.method).toBe("POST");

    const body = JSON.parse(init.body as string) as {
      code: string;
      code_verifier: string;
      code_challenge_method: string;
    };
    expect(body.code).toBe("MY_CODE");
    expect(body.code_challenge_method).toBe("S256");
    expect(typeof body.code_verifier).toBe("string");
    expect(body.code_verifier.length).toBeGreaterThanOrEqual(43);
  });

  it("returns { ok: false, error } when token endpoint returns 400", async () => {
    (chrome.identity.launchWebAuthFlow as ReturnType<typeof vi.fn>).mockResolvedValue(
      "https://abc.chromiumapp.org/?code=BAD_CODE"
    );

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "invalid_grant",
      json: async () => ({}),
    } as Response);

    const result = await connectOpenRouter();

    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");
    expect(result.error).toContain("400");
    expect(result.keyId).toBeUndefined();
  });

  it("returns { ok: false, error } when chrome.identity.launchWebAuthFlow throws", async () => {
    (chrome.identity.launchWebAuthFlow as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("The user did not approve access.")
    );

    globalThis.fetch = vi.fn();

    const result = await connectOpenRouter();

    expect(result.ok).toBe(false);
    expect(result.error).toContain("The user did not approve access.");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("returns { ok: false, error } when redirect URL has no code param", async () => {
    (chrome.identity.launchWebAuthFlow as ReturnType<typeof vi.fn>).mockResolvedValue(
      "https://abc.chromiumapp.org/?error=access_denied"
    );

    globalThis.fetch = vi.fn();

    const result = await connectOpenRouter();

    expect(result.ok).toBe(false);
    expect(result.error).toContain("No authorization code");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("returns { ok: false, error } when response has no key field", async () => {
    (chrome.identity.launchWebAuthFlow as ReturnType<typeof vi.fn>).mockResolvedValue(
      "https://abc.chromiumapp.org/?code=VALID_CODE"
    );

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: "unexpected shape" }),
      text: async () => "",
    } as Response);

    const result = await connectOpenRouter();

    expect(result.ok).toBe(false);
    expect(result.error).toContain("key field");
  });
});