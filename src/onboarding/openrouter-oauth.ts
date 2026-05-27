/**
 * onboarding/openrouter-oauth.ts
 *
 * OpenRouter OAuth PKCE S256 flow for Chrome extensions.
 *
 * The flow:
 *  1. Generate a random code_verifier (43-128 URL-safe chars).
 *  2. Compute code_challenge = base64url(SHA-256(verifier)) via Web Crypto.
 *  3. Open the OpenRouter OAuth page via chrome.identity.launchWebAuthFlow.
 *  4. Parse the `code` query param from the redirect URL.
 *  5. Exchange `code` + `code_verifier` for a user-controlled API key.
 *  6. Store the key via saveKey() and return its generated keyId.
 *
 * Exported public API:
 *   connectOpenRouter()       — full PKCE flow, returns { ok, keyId?, error? }
 *   generatePkcePair()        — helper: generate { verifier, challenge }
 *   parseCodeFromRedirect()   — helper: extract `code` from a redirect URL string
 *
 * The two helpers are exported so unit tests can verify each step in isolation
 * without invoking chrome.identity or fetch.
 */

import { saveKey } from "@/storage/keys";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OPENROUTER_AUTH_URL = "https://openrouter.ai/auth";
const OPENROUTER_KEYS_ENDPOINT = "https://openrouter.ai/api/v1/auth/keys";
const VERIFIER_LENGTH = 64; // characters, within 43-128 range per RFC 7636

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

/**
 * Generate a URL-safe random string of exactly `len` characters drawn from
 * the RFC 7636 unreserved character set: [A-Z a-z 0-9 - . _ ~].
 */
function randomUrlSafeString(len: number): string {
  const charset =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => charset[b % charset.length]).join("");
}

/**
 * base64url-encode an ArrayBuffer (base64 with + -> -, / -> _, no padding).
 */
function base64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Compute base64url(SHA-256(verifier)).
 */
async function computeChallenge(verifier: string): Promise<string> {
  const encoded = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return base64url(digest);
}

/**
 * Generate a PKCE verifier + challenge pair.
 *
 * Exported so tests can verify S256 correctness independently.
 */
export async function generatePkcePair(): Promise<{
  verifier: string;
  challenge: string;
}> {
  const verifier = randomUrlSafeString(VERIFIER_LENGTH);
  const challenge = await computeChallenge(verifier);
  return { verifier, challenge };
}

// ---------------------------------------------------------------------------
// Redirect URL parsing
// ---------------------------------------------------------------------------

/**
 * Extract the `code` query parameter from a redirect URL string.
 *
 * Example input: "https://abc.chromiumapp.org/?code=XYZ&state=foo"
 * Returns: "XYZ"
 *
 * Returns null if the `code` param is absent.
 * Exported so tests can verify URL parsing without invoking chrome.identity.
 */
export function parseCodeFromRedirect(redirectUrl: string): string | null {
  try {
    const url = new URL(redirectUrl);
    return url.searchParams.get("code");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

/**
 * Run the full OpenRouter OAuth PKCE S256 flow:
 *  1. Generate verifier + challenge
 *  2. Open OpenRouter auth page via chrome.identity.launchWebAuthFlow
 *  3. Parse the authorization code from the redirect
 *  4. Exchange code for an API key
 *  5. Persist the key and return its keyId
 *
 * Returns { ok: true, keyId } on success, { ok: false, error } on any failure.
 */
export async function connectOpenRouter(): Promise<{
  ok: boolean;
  keyId?: string;
  error?: string;
}> {
  try {
    // Step 1: PKCE pair
    const { verifier, challenge } = await generatePkcePair();

    // Step 2: Extension redirect URL registered with Chrome
    const redirectUrl: string = chrome.identity.getRedirectURL();

    // Step 3: Build auth URL and open the OAuth page
    const authUrl =
      `${OPENROUTER_AUTH_URL}` +
      `?callback_url=${encodeURIComponent(redirectUrl)}` +
      `&code_challenge=${encodeURIComponent(challenge)}` +
      `&code_challenge_method=S256`;

    const redirectResponse: string | undefined = await chrome.identity.launchWebAuthFlow({
      url: authUrl,
      interactive: true,
    });

    // Step 4: Parse authorization code from redirect
    const code = redirectResponse ? parseCodeFromRedirect(redirectResponse) : null;
    if (!code) {
      return {
        ok: false,
        error: `No authorization code in redirect: ${redirectResponse}`,
      };
    }

    // Step 5: Exchange code for an API key
    const response = await fetch(OPENROUTER_KEYS_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        code_verifier: verifier,
        code_challenge_method: "S256",
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => String(response.status));
      return {
        ok: false,
        error: `OpenRouter key exchange failed (${response.status}): ${text}`,
      };
    }

    const json = (await response.json()) as { key?: string };
    if (!json.key) {
      return {
        ok: false,
        error: "OpenRouter response did not include a key field",
      };
    }

    // Step 6: Persist the key
    const keyId = await saveKey("openrouter", json.key, "oauth");
    return { ok: true, keyId };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}
