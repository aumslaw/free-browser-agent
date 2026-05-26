/**
 * providers/cerebras.ts
 *
 * Qwen3 235B (or Llama 3.3 70B) via Cerebras Cloud (https://api.cerebras.ai/v1).
 * Cerebras is fully OpenAI-compatible — fastest inference available on free tier.
 */

import { Provider } from "./base.js";
import type {
  CompletionOptions,
  ChatCompletionResponse,
  ChatCompletionChunk,
} from "./base.js";
import type { ChatMessage } from "@/shared/types.js";

const API_BASE = "https://api.cerebras.ai/v1";

export class CerebrasProvider extends Provider {
  readonly id = "cerebras";
  readonly name = "Cerebras";
  readonly defaultModel = "qwen-3-235b";

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
    data._routed_via = { provider: "cerebras", model };
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
    if (!reader) throw new Error("[cerebras] No response body");

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
