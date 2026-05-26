/**
 * providers/groq.ts
 *
 * Llama 3.3 70B via Groq cloud (https://api.groq.com/openai/v1).
 * Groq is fully OpenAI-compatible — just a different base URL and bearer token.
 */

import { Provider } from "./base.js";
import type {
  CompletionOptions,
  ChatCompletionResponse,
  ChatCompletionChunk,
} from "./base.js";
import type { ChatMessage } from "@/shared/types.js";

const API_BASE = "https://api.groq.com/openai/v1";

export class GroqProvider extends Provider {
  readonly id = "groq";
  readonly name = "Groq";
  readonly defaultModel = "llama-3.3-70b-versatile";

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
    data._routed_via = { provider: "groq", model };
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
    if (!reader) throw new Error("[groq] No response body");

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
