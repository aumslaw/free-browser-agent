/**
 * test/history.test.ts
 *
 * Unit tests for src/sidepanel/lib/history.ts.
 * Mocks chrome.storage.local with an in-memory backing that supports the
 * callback form used by the module: get(key, cb) / set(obj, cb).
 *
 * Tests cover:
 *   1.  createConversation → appears in listConversations
 *   2.  createConversation → stored with id, title "New chat", empty messages
 *   3.  saveConversation (upsert) bumps updatedAt and keeps correct content
 *   4.  saveConversation reorders list (newest first)
 *   5.  getConversation returns full object for known id
 *   6.  getConversation returns null for unknown id
 *   7.  deleteConversation removes entry; no-op on unknown id
 *   8.  deriveTitle — no messages → "New chat"
 *   9.  deriveTitle — first user message truncated at 40 chars + "…"
 *  10.  deriveTitle — skips non-user messages; uses first user msg
 *  11.  deriveTitle — user message exactly 40 chars is NOT truncated
 *  12.  getLastActiveId / setLastActiveId round-trip
 *  13.  getLastActiveId returns null when nothing stored
 */

import { describe, it, expect, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// chrome.storage.local mock — callback form (get(key, cb) / set(obj, cb))
// ---------------------------------------------------------------------------

type StorageStore = Record<string, unknown>;
const store: StorageStore = {};

function clearStore() {
  for (const k of Object.keys(store)) delete store[k];
}

(globalThis as Record<string, unknown>).chrome = {
  storage: {
    local: {
      get(key: string, cb: (result: Record<string, unknown>) => void) {
        cb({ [key]: store[key] });
      },
      set(obj: Record<string, unknown>, cb: () => void) {
        Object.assign(store, obj);
        cb();
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Module under test (imported AFTER the mock is installed)
// ---------------------------------------------------------------------------

import {
  createConversation,
  listConversations,
  getConversation,
  saveConversation,
  deleteConversation,
  deriveTitle,
  getLastActiveId,
  setLastActiveId,
} from "../src/sidepanel/lib/history.js";

import type { StoredMessage, Conversation } from "../src/sidepanel/lib/history.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal StoredMessage for testing. */
function msg(
  role: StoredMessage["role"],
  text: string,
  extra?: Partial<StoredMessage>
): StoredMessage {
  return { id: Math.random().toString(36).slice(2), role, text, ...extra };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createConversation", () => {
  beforeEach(clearStore);

  it("created conversation appears in listConversations", async () => {
    const c = await createConversation();
    const list = await listConversations();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(c.id);
  });

  it("has title 'New chat', empty messages, and numeric timestamps", async () => {
    const c = await createConversation();
    expect(c.title).toBe("New chat");
    expect(c.messages).toHaveLength(0);
    expect(typeof c.createdAt).toBe("number");
    expect(typeof c.updatedAt).toBe("number");
    expect(c.id).toBeTruthy();
  });
});

describe("saveConversation — upsert", () => {
  beforeEach(clearStore);

  it("saves a new conversation and makes it retrievable", async () => {
    const c = await createConversation();
    const updated: Conversation = {
      ...c,
      messages: [msg("user", "hello")],
    };
    await saveConversation(updated);

    const retrieved = await getConversation(c.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.messages).toHaveLength(1);
    expect(retrieved!.messages[0].text).toBe("hello");
  });

  it("bumps updatedAt on save", async () => {
    const c = await createConversation();
    const beforeSave = c.updatedAt;

    // Ensure at least 1 ms gap
    await new Promise((r) => setTimeout(r, 2));

    await saveConversation({ ...c, messages: [msg("user", "ping")] });
    const retrieved = await getConversation(c.id);
    expect(retrieved!.updatedAt).toBeGreaterThan(beforeSave);
  });

  it("listConversations returns newest-updatedAt first after multiple saves", async () => {
    const c1 = await createConversation();
    // Brief gap so updatedAt differs
    await new Promise((r) => setTimeout(r, 2));
    const c2 = await createConversation();
    await new Promise((r) => setTimeout(r, 2));

    // Save c1 last → c1 should be first in list
    await saveConversation({ ...c1, messages: [msg("user", "hi")] });

    const list = await listConversations();
    expect(list[0].id).toBe(c1.id);
    expect(list[1].id).toBe(c2.id);
  });
});

describe("getConversation", () => {
  beforeEach(clearStore);

  it("returns the full conversation for a known id", async () => {
    const c = await createConversation();
    const result = await getConversation(c.id);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(c.id);
  });

  it("returns null for an unknown id", async () => {
    const result = await getConversation("does-not-exist");
    expect(result).toBeNull();
  });
});

describe("deleteConversation", () => {
  beforeEach(clearStore);

  it("removes an existing conversation", async () => {
    const c = await createConversation();
    await deleteConversation(c.id);

    const list = await listConversations();
    expect(list).toHaveLength(0);
    expect(await getConversation(c.id)).toBeNull();
  });

  it("is a no-op for an unknown id (does not throw)", async () => {
    const c = await createConversation();
    await expect(deleteConversation("ghost-id")).resolves.toBeUndefined();

    // Original still present
    const list = await listConversations();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(c.id);
  });
});

describe("deriveTitle", () => {
  it("returns 'New chat' when messages array is empty", () => {
    expect(deriveTitle([])).toBe("New chat");
  });

  it("returns 'New chat' when there are no user messages", () => {
    expect(deriveTitle([msg("assistant", "hello"), msg("tool", "result")])).toBe("New chat");
  });

  it("returns 'New chat' when user message has empty text", () => {
    expect(deriveTitle([msg("user", "   ")])).toBe("New chat");
  });

  it("returns the full text when it is ≤ 40 chars", () => {
    const text = "Short message here";
    expect(deriveTitle([msg("user", text)])).toBe(text);
  });

  it("returns exactly 40 chars (no ellipsis) when text is exactly 40 chars", () => {
    const text = "A".repeat(40);
    expect(deriveTitle([msg("user", text)])).toBe(text);
  });

  it("truncates to 40 chars + '…' when text exceeds 40 chars", () => {
    const text = "B".repeat(80);
    const result = deriveTitle([msg("user", text)]);
    expect(result).toBe("B".repeat(40) + "…");
    expect(result.length).toBe(41); // 40 chars + '…' which is 1 JS code unit (U+2026)
  });

  it("skips non-user messages and uses the first user message", () => {
    const messages: StoredMessage[] = [
      msg("assistant", "I am the assistant"),
      msg("tool", "tool output"),
      msg("user", "actual user prompt"),
    ];
    expect(deriveTitle(messages)).toBe("actual user prompt");
  });

  it("uses the first user message, not the second", () => {
    const messages: StoredMessage[] = [
      msg("user", "first"),
      msg("user", "second"),
    ];
    expect(deriveTitle(messages)).toBe("first");
  });
});

describe("getLastActiveId / setLastActiveId", () => {
  beforeEach(clearStore);

  it("returns null before anything is set", async () => {
    expect(await getLastActiveId()).toBeNull();
  });

  it("round-trips an id correctly", async () => {
    const c = await createConversation();
    await setLastActiveId(c.id);
    const retrieved = await getLastActiveId();
    expect(retrieved).toBe(c.id);
  });

  it("overwrites the previous value on a second set", async () => {
    const c1 = await createConversation();
    const c2 = await createConversation();

    await setLastActiveId(c1.id);
    await setLastActiveId(c2.id);

    expect(await getLastActiveId()).toBe(c2.id);
  });
});
