/**
 * shared/messages.ts
 *
 * Typed runtime message envelopes for all communication channels:
 *   background (SW)  ↔  content script
 *   background (SW)  ↔  side panel
 *   background (SW)  ↔  options page
 *
 * Every message has a `kind` discriminant so the receiver can narrow safely.
 *
 * Usage pattern (sending from any context):
 *   chrome.runtime.sendMessage<BackgroundMessage, BackgroundResponse>(msg)
 *
 * Usage pattern (content script ← background):
 *   chrome.tabs.sendMessage<ContentMessage, ContentResponse>(tabId, msg)
 */

import type {
  AgentStatus,
  AssistantMessage,
  ChatMessage,
  ProviderId,
  ProviderPriorityList,
  StoredKey,
} from "./types.js";

// ---------------------------------------------------------------------------
// DOM operation types (mirrored in tools.ts as OpenAI tool defs)
// ---------------------------------------------------------------------------

export interface ClickArgs {
  selector: string;
}
export interface TypeArgs {
  selector: string;
  text: string;
  /** If true, clear the field before typing. Default: false. */
  clear?: boolean;
}
export interface FillFormArgs {
  /** Map of CSS selector → value to fill. */
  fields: Record<string, string>;
}
export interface ScrollArgs {
  /** If provided, scroll to this CSS selector. */
  selector?: string;
  /** Pixel offset X (used when selector is absent). */
  x?: number;
  /** Pixel offset Y (used when selector is absent). */
  y?: number;
}
export interface WaitForSelectorArgs {
  selector: string;
  /** Timeout in ms. Default: 5000. */
  timeout?: number;
}
export interface GetUrlArgs {
  // no args — returns current URL
}
export interface GetSelectionArgs {
  // no args — returns selected text
}
export interface ReadPageArgs {
  // no args — returns page content as markdown
}

/** Discriminated union of all DOM-op argument shapes. */
export type DomOpArgs =
  | ({ op: "click" } & ClickArgs)
  | ({ op: "type" } & TypeArgs)
  | ({ op: "fillForm" } & FillFormArgs)
  | ({ op: "scroll" } & ScrollArgs)
  | ({ op: "waitForSelector" } & WaitForSelectorArgs)
  | ({ op: "getUrl" } & GetUrlArgs)
  | ({ op: "getSelection" } & GetSelectionArgs)
  | ({ op: "readPage" } & ReadPageArgs);

/** Result shape from a content-script DOM op. */
export interface DomOpResult {
  ok: boolean;
  /** Stringified result data (URL string, page markdown, selected text, etc.). */
  result?: string;
  error?: string;
  /** When set, agent-loop should re-attempt via CDP. */
  escalate?: "cdp";
}

// ---------------------------------------------------------------------------
// Messages going TO the content script (background → content)
// ---------------------------------------------------------------------------

/** Run a DOM operation in the page. */
export interface ContentDomOpMessage {
  kind: "dom-op";
  /** The specific operation + its arguments (discriminated by `op`). */
  payload: DomOpArgs;
}

/** Ping the content script to check it's alive. */
export interface ContentPingMessage {
  kind: "content:ping";
}

export type ContentMessage = ContentDomOpMessage | ContentPingMessage;

export type ContentResponse = DomOpResult | { kind: "pong" };

// ---------------------------------------------------------------------------
// Messages going TO the background service worker
// ---------------------------------------------------------------------------

/** Start the agent loop for the active tab. */
export interface BgStartAgentMessage {
  kind: "agent:start";
  tabId: number;
  messages: ChatMessage[];
}

/** Stop the agent loop (if running). */
export interface BgStopAgentMessage {
  kind: "agent:stop";
  tabId: number;
}

/** Save a provider API key. */
export interface BgSaveKeyMessage {
  kind: "keys:save";
  provider: ProviderId;
  label: string;
  /** Plaintext key — background encrypts it before storage. */
  plaintext: string;
}

/** Delete a stored key by ID. */
export interface BgDeleteKeyMessage {
  kind: "keys:delete";
  id: string;
}

/** List stored keys (returns metadata only, not plaintext). */
export interface BgListKeysMessage {
  kind: "keys:list";
}

/** Get the current provider priority list. */
export interface BgGetPriorityMessage {
  kind: "priority:get";
}

/** Save the provider priority list. */
export interface BgSetPriorityMessage {
  kind: "priority:set";
  list: ProviderPriorityList;
}

/** Test whether a specific provider key is reachable. */
export interface BgTestKeyMessage {
  kind: "keys:test";
  id: string;
}

export type BackgroundMessage =
  | BgStartAgentMessage
  | BgStopAgentMessage
  | BgSaveKeyMessage
  | BgDeleteKeyMessage
  | BgListKeysMessage
  | BgGetPriorityMessage
  | BgSetPriorityMessage
  | BgTestKeyMessage;

/** Generic success/error wrapper for background responses. */
export type BackgroundResponse<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export type KeysListResponse = BackgroundResponse<Omit<StoredKey, "envelope">[]>;
export type KeysSaveResponse = BackgroundResponse<{ id: string }>;
export type KeysDeleteResponse = BackgroundResponse<void>;
export type KeysTestResponse = BackgroundResponse<{ latency_ms: number; model: string }>;
export type PriorityGetResponse = BackgroundResponse<ProviderPriorityList>;
export type PrioritySetResponse = BackgroundResponse<void>;

// ---------------------------------------------------------------------------
// Messages flowing FROM the background to the side panel / options page
// (sent via chrome.runtime.sendMessage in broadcast mode)
// ---------------------------------------------------------------------------

/** Agent status update streamed to the side panel. */
export interface AgentStatusMessage {
  kind: "agent:status";
  tabId: number;
  status: AgentStatus;
}

/** Final assistant response for the active tab. */
export interface AgentReplyMessage {
  kind: "agent:reply";
  tabId: number;
  message: AssistantMessage;
}

/** Streaming delta (P1 — when streaming is enabled). */
export interface AgentStreamDeltaMessage {
  kind: "agent:stream_delta";
  tabId: number;
  delta: string;
  /** Provider that served this delta. */
  routed_via: string;
}

export type BroadcastMessage =
  | AgentStatusMessage
  | AgentReplyMessage
  | AgentStreamDeltaMessage;
