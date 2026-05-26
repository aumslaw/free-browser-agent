/**
 * providers/openrouter.ts
 *
 * Free-tier models via OpenRouter (https://openrouter.ai/api/v1).
 * OpenRouter is OpenAI-compatible. Uses Kimi K2 or DeepSeek-R1 free tier by default.
 *
 * Free models on OpenRouter require:
 *   - HTTP-Referer header (your site or "chrome-extension://...")
 *   - X-Title header (human-readable app name)
 */

import { Provider } from "./base.js";
import type {
  CompletionOptions,
  ChatCompletionResponse,
  ChatCompletionChunk,
} from "./base.js";
import type { ChatMessage } from "@/shared/types.js";

const API_BASE = "https://openrouter.ai/api/v1";

/**
 * Free models available on OpenRouter (no per-token charge).
 * The router will use the first one configured; users can override in settings.
 */
export const OPENROUTER_FREE_MODELS = [
  "deepseek/deepseek-r1:free",
  "moonshotai/kimi-k2:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "google/gemma-3-27b-it:free",
] as const;

export class OpenRouterProvider extends Provider {
  readonly id = "openrouter";
  readonly name = "OpenRouter";
  readonly defaultModel = "deepseek/deepseek-r1:free";

  private readonly extraHeaders: Record<string, string>;

  constructor(opts?: { referer?: string; title?: string }) {
    super();
    this.extraHeaders = {
      "HTTP-Referer": opts?.referer ?? "https://github.com/aumslaw/free-browser-agent",
      "X-Title": opts?.title ?? "Free Browser Agent",
    };
  }

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    model: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    const res = await this.fetchWithTimeout(`${API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...this.extraHeaders,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: options?.temperature,
        max_tokens: options?.max_tokens,
        top_p: options?.top_p,
        tools: options?.tools,
        tool_choice: options?.tool_choice,
        parallel_tool_calls: options?.parallel_tool_calls,
      }),
    });

    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      this.httpError(res.status, raw);
    }

    const data = await res.json() as ChatCompletionResponse;
    // OpenRouter may wrap the error inside a 200 with error field
    if ((data as unknown as { error?: { code?: number; message?: string } }).error) {
      const e = (data as unknown as { error: { code?: number; message?: string } }).error;
      const statusCode = e.code ?? 500;
      this.httpError(statusCode, e.message ?? "Unknown OpenRouter error");
    }
    data._routed_via = { provider: "openrouter", model };
    return data;
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    model: string,
    options?: CompletionOptions,
  ): AsyncIterable<ChatCompletionChunk> {
    const res = await this.fetchWithTimeout(`${API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...this.extraHeaders,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: options?.temperature,
        max_tokens: options?.max_tokens,
        top_p: options?.top_p,
        tools: options?.tools,
        tool_choice: options?.tool_choice,
        parallel_tool_calls: options?.parallel_tool_calls,
        stream: true,
      }),
    }, 30_000);

    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      this.httpError(res.status, raw);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error("[openrouter] No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const raw = trimmed.slice(6);
        if (raw === "[DONE]") return;
        try {
          yield JSON.parse(raw) as ChatCompletionChunk;
        } catch {
          // skip malformed chunk
        }
      }
    }
  }
}
