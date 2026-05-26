/**
 * shared/types.ts
 *
 * Core domain types used across the extension:
 * background ↔ content ↔ sidepanel ↔ options.
 *
 * Shapes follow the OpenAI Chat Completions API wherever possible so the
 * provider adapters can pass-through with minimal transformation.
 */

// ---------------------------------------------------------------------------
// Provider identifiers
// ---------------------------------------------------------------------------

/** Canonical IDs for the free-tier LLM providers. */
export type ProviderId =
  | "google"
  | "groq"
  | "cerebras"
  | "openrouter";

// ---------------------------------------------------------------------------
// OpenAI-compatible message shapes
// ---------------------------------------------------------------------------

/** A single function/tool call emitted by the model. */
export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    /** JSON-serialised arguments. */
    arguments: string;
  };
}

/** The content of a tool-result message (role:"tool"). */
export interface ToolResult {
  tool_call_id: string;
  content: string;
  /** Set to true when the tool execution failed. */
  is_error?: boolean;
}

/** System prompt message. */
export interface SystemMessage {
  role: "system";
  content: string;
}

/** User message — may be plain text or a multi-part array. */
export interface UserMessage {
  role: "user";
  content:
    | string
    | Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } }
      >;
}

/** Assistant message, optionally containing tool calls. */
export interface AssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
  /** Set by the router — which provider/model served this response. */
  _routed_via?: string;
}

/** Tool-result message returned from the extension to the model. */
export interface ToolMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}

/** Union of all OpenAI-compatible message types. */
export type ChatMessage =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolMessage;

// ---------------------------------------------------------------------------
// Generic message envelope (re-exported for convenience)
// ---------------------------------------------------------------------------

/** Alias kept for compatibility with earlier drafts. */
export type Message = ChatMessage;

// ---------------------------------------------------------------------------
// Router types
// ---------------------------------------------------------------------------

/** A single provider+model pair the router can dispatch to. */
export interface ProviderTarget {
  providerId: ProviderId;
  model: string;
  /** Human label shown in the UI. */
  label?: string;
}

/** Rate-limit counters tracked per (providerId, model, keyId) triple. */
export interface RateLimitState {
  rpm_used: number;
  rpd_used: number;
  tpm_used: number;
  tpd_used: number;
  /** Unix-ms timestamp after which this key is eligible again. 0 = healthy. */
  cooldown_until: number;
  /** ISO string of the last time the RPM window was reset. */
  rpm_window_start: string;
  /** ISO string of the last time the RPD window was reset. */
  rpd_window_start: string;
}

/** Metadata the router attaches to every completion response. */
export interface RoutingMetadata {
  provider: ProviderId;
  model: string;
  /** Key-index used (not the actual key). */
  key_index: number;
  /** Wall-clock latency in ms. */
  latency_ms: number;
}

// ---------------------------------------------------------------------------
// Agent-loop types
// ---------------------------------------------------------------------------

/** Status broadcast from the agent loop to the side panel. */
export type AgentStatus =
  | { kind: "agent:status"; phase: "thinking"; iteration: number }
  | { kind: "agent:status"; phase: "tool_call"; tool: string; args: Record<string, unknown> }
  | { kind: "agent:status"; phase: "tool_result"; tool: string; result: string; ok: boolean }
  | { kind: "agent:status"; phase: "done"; message: AssistantMessage }
  | { kind: "agent:status"; phase: "error"; error: string }
  | { kind: "agent:status"; phase: "max_iterations" };

// ---------------------------------------------------------------------------
// Storage types
// ---------------------------------------------------------------------------

/** An encrypted provider-key envelope stored in chrome.storage.local. */
export interface EncryptedKeyEnvelope {
  /** Base-64 encoded 12-byte IV. */
  iv: string;
  /** Base-64 encoded ciphertext (includes 16-byte GCM auth tag appended by WebCrypto). */
  ct: string;
}

/** A saved provider-key record (the plaintext key is never stored at rest). */
export interface StoredKey {
  id: string;
  provider: ProviderId;
  label: string;
  /** The encrypted key material. */
  envelope: EncryptedKeyEnvelope;
  created_at: string;
}

/** User-defined provider priority order (index 0 = highest priority). */
export type ProviderPriorityList = Array<{
  providerId: ProviderId;
  model: string;
  /** User-assigned key IDs for this provider. */
  key_ids: string[];
  enabled: boolean;
}>;
