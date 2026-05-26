/**
 * storage/crypto.ts
 *
 * AES-256-GCM encryption for provider keys using the WebCrypto subtle API.
 *
 * Master key lifecycle:
 *   - Generated on first use via crypto.subtle.generateKey (AES-GCM, 256-bit)
 *   - Exported as a JsonWebKey and persisted in chrome.storage.session
 *     (session storage is scoped to the browser session — it clears on browser
 *     quit, so the master key is ephemeral and never survives a restart)
 *   - On subsequent calls within the same session the JWK is re-imported
 *
 * Ciphertext envelope: { iv: base64(12 bytes), ct: base64(ciphertext || 16-byte auth tag) }
 * The GCM auth tag is appended automatically by WebCrypto to the ciphertext buffer.
 */

import type { EncryptedKeyEnvelope } from "@/shared/types";

// ----- constants -----------------------------------------------------------

const SESSION_KEY_NAME = "fba_master_key_jwk";
const AES_PARAMS: AesKeyGenParams = { name: "AES-GCM", length: 256 };
const IV_BYTES = 12;

// ----- helpers -------------------------------------------------------------

function toBase64(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// ----- master key ----------------------------------------------------------

/**
 * Returns the session-scoped master CryptoKey.
 * Creates + persists a new one if none is stored in chrome.storage.session.
 */
export async function getOrCreateMasterKey(): Promise<CryptoKey> {
  // Try to load persisted JWK from session storage
  const stored = await chrome.storage.session.get(SESSION_KEY_NAME);
  const jwk = stored[SESSION_KEY_NAME] as JsonWebKey | undefined;

  if (jwk) {
    return crypto.subtle.importKey(
      "jwk",
      jwk,
      AES_PARAMS,
      /* extractable = */ true,
      ["encrypt", "decrypt"],
    );
  }

  // Generate a brand-new key
  const key = await crypto.subtle.generateKey(AES_PARAMS, /* extractable = */ true, [
    "encrypt",
    "decrypt",
  ]);

  // Export and persist so subsequent calls within the session reuse it
  const exported = await crypto.subtle.exportKey("jwk", key);
  await chrome.storage.session.set({ [SESSION_KEY_NAME]: exported });

  return key;
}

// ----- encrypt / decrypt ---------------------------------------------------

/**
 * Encrypts a UTF-8 plaintext string using the master key.
 * Returns an envelope with base64-encoded IV and ciphertext (ciphertext
 * already includes the 16-byte GCM auth tag appended by WebCrypto).
 */
export async function encrypt(plaintext: string): Promise<EncryptedKeyEnvelope> {
  const key = await getOrCreateMasterKey();

  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const encoded = new TextEncoder().encode(plaintext);

  const cipherBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv.buffer.slice(0) as ArrayBuffer },
    key,
    encoded.buffer.slice(0) as ArrayBuffer,
  );

  return {
    iv: toBase64(iv),
    ct: toBase64(cipherBuffer),
  };
}

/**
 * Decrypts an envelope produced by `encrypt()`.
 * Throws if the auth tag is invalid (tampered data) or the master key has
 * been rotated (session ended and restarted).
 */
export async function decrypt(envelope: EncryptedKeyEnvelope): Promise<string> {
  const key = await getOrCreateMasterKey();

  const iv = fromBase64(envelope.iv);
  const ct = fromBase64(envelope.ct);

  const plainBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv.buffer.slice(0) as ArrayBuffer },
    key,
    ct.buffer.slice(0) as ArrayBuffer,
  );

  return new TextDecoder().decode(plainBuffer);
}
