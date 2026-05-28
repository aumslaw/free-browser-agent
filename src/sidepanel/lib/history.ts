/**
 * history.ts
 * Conversation-history persistence layer for the free-browser-agent side panel.
 * Backed by chrome.storage.local (NOT sync — quota reasons).
 *
 * Storage keys:
 *   fba:conversations  →  Record<string, Conversation>  (id-keyed map)
 *   fba:lastActive     →  string  (conversation id)
 */

/**
 * The message shape used by the free-browser-agent side panel.
 * Self-contained — does NOT import from App.tsx.
 */
export interface StoredMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  streaming?: boolean;
  routedVia?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: string;
  toolOk?: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: StoredMessage[];
}

export interface ConversationMeta {
  id: string;
  title: string;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Internal storage helpers
// ---------------------------------------------------------------------------

const CONV_KEY = "fba:conversations";
const LAST_KEY = "fba:lastActive";

function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function getMap(): Promise<Record<string, Conversation>> {
  return new Promise((resolve) => {
    chrome.storage.local.get(CONV_KEY, (result) => {
      resolve((result[CONV_KEY] as Record<string, Conversation>) ?? {});
    });
  });
}

async function setMap(map: Record<string, Conversation>): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [CONV_KEY]: map }, () => resolve());
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** List all conversations as lightweight meta objects, sorted by updatedAt DESC. */
export async function listConversations(): Promise<ConversationMeta[]> {
  const map = await getMap();
  return Object.values(map)
    .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Retrieve a full conversation by id, or null if not found. */
export async function getConversation(id: string): Promise<Conversation | null> {
  const map = await getMap();
  return map[id] ?? null;
}

/**
 * Upsert a conversation.
 * Always bumps updatedAt to Date.now() before saving.
 */
export async function saveConversation(c: Conversation): Promise<void> {
  const map = await getMap();
  map[c.id] = { ...c, updatedAt: Date.now() };
  await setMap(map);
}

/** Permanently remove a conversation. No-op if the id does not exist. */
export async function deleteConversation(id: string): Promise<void> {
  const map = await getMap();
  delete map[id];
  await setMap(map);
}

/**
 * Create a new, empty conversation, persist it, and return it.
 * title = "New chat", messages = [], createdAt = updatedAt = now.
 */
export async function createConversation(): Promise<Conversation> {
  const now = Date.now();
  const c: Conversation = {
    id: generateId(),
    title: "New chat",
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  const map = await getMap();
  map[c.id] = c;
  await setMap(map);
  return c;
}

/**
 * Derive a short display title from the conversation's message list.
 * Uses the first user message's text, trimmed to ~40 chars + "…".
 * Returns "New chat" when no user messages with non-empty text exist.
 */
export function deriveTitle(messages: StoredMessage[]): string {
  const first = messages.find((m) => m.role === "user" && m.text.trim() !== "");
  if (!first) return "New chat";
  const text = first.text.trim();
  return text.length > 40 ? text.slice(0, 40) + "…" : text;
}

/** Get the id of the last active conversation, or null. */
export async function getLastActiveId(): Promise<string | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get(LAST_KEY, (result) => {
      resolve((result[LAST_KEY] as string) ?? null);
    });
  });
}

/** Persist the id of the last active conversation. */
export async function setLastActiveId(id: string): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [LAST_KEY]: id }, () => resolve());
  });
}
