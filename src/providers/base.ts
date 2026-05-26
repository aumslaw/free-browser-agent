/**
 * providers/base.ts
 *
 * Abstract base class and shared types for all LLM provider adapters.
 * Shapes follow the OpenAI Chat Completions API.
 */

import type { ChatMessage, ToolCall } from "@/shared/types.js";

// ---------------------------------------------------------------------------
// Request / response shapes
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export type ToolChoice =
  | "none"
  | "auto"
  | "required"
  | { type: "function"; function: { name: string } };

export interface CompletionOptions {
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  tools?: ToolDefinition[];
  tool_choice?: ToolChoice;
  parallel_tool_calls?: boolean;
}

export interface ChatCompletionMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatCompletionMessage;
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: TokenUsage;
  /** Injected by the router — not part of the wire format. */
  _routed_via?: { provider: string; model: string };
}

// Streaming delta
export interface StreamDelta {
  content?: string | null;
  tool_calls?: ToolCall[];
}

export interface StreamChoice {
  index: number;
  delta: StreamDelta;
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: StreamChoice[];
}

// ---------------------------------------------------------------------------
// Abstract provider
// ---------------------------------------------------------------------------

export abstract class Provider {
  /** Stable identifier used in rate-limit ledger keys and routing metadata. */
  abstract readonly id: string;
  abstract readonly name: string;

  /** Default model to use when none is specified by the router entry. */
  abstract readonly defaultModel: string;

  /**
   * Non-streaming completion. Returns a full OpenAI-compatible response.
   */
  abstract chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    model: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse>;

  /**
   * Streaming completion. Yields OpenAI-compatible chunks.
   */
  abstract streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    model: string,
    options?: CompletionOptions,
  ): AsyncIterable<ChatCompletionChunk>;

  // -------------------------------------------------------------------------
  // Utilities shared by all adapters
  // -------------------------------------------------------------------------

  protected async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs = 20_000,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  protected makeId(): string {
    return `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Throw an annotated error that carries the HTTP status code so the router
   * can distinguish 429 / 5xx from hard client errors.
   */
  protected httpError(status: number, body: string): never {
    const err = new Error(`[${this.id}] HTTP ${status}: ${body}`) as Error & { status: number };
    err.status = status;
    throw err;
  }
}
