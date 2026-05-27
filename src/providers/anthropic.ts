/**
 * providers/anthropic.ts
 *
 * Anthropic Claude (Sonnet / Haiku / Opus) via api.anthropic.com.
 *
 * Translates OpenAI Chat Completions shape ↔ Anthropic Messages API:
 *   - OpenAI `messages: [{role: "system"|"user"|"assistant"|"tool", content}]`
 *   - Anthropic `messages: [{role: "user"|"assistant", content}]` + separate `system`.
 *   - OpenAI `tool_calls[]` ↔ Anthropic `content: [{type:"tool_use", id, name, input}]`
 *   - OpenAI `{role:"tool", tool_call_id, content}` ↔ Anthropic
 *     `{role:"user", content: [{type:"tool_result", tool_use_id, content}]}`
 *
 * Anthropic offers a free $5 trial credit per new account, which qualifies it as
 * a free-tier option alongside Google / Groq / Cerebras / OpenRouter for the
 * purposes of this open-source extension.
 */

import { Provider } from "./base.js";
import type {
  CompletionOptions,
  ChatCompletionResponse,
  ChatCompletionChunk,
} from "./base.js";
import type { ChatMessage, ToolCall } from "@/shared/types.js";

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
    | { type: "tool_result"; tool_use_id: string; content: string }
  >;
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicResponse {
  id: string;
  model: string;
  role: "assistant";
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  >;
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | null;
  usage?: { input_tokens: number; output_tokens: number };
}

/**
 * Translate OpenAI messages → Anthropic messages + system.
 */
function translateMessages(messages: ChatMessage[]): {
  system?: string;
  anthropic: AnthropicMessage[];
} {
  let system: string | undefined;
  const anthropic: AnthropicMessage[] = [];

  for (const m of messages) {
    if (m.role === "system") {
      system = (system ? system + "\n\n" : "") + (m.content ?? "");
      continue;
    }
    if (m.role === "tool") {
      anthropic.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.tool_call_id ?? "",
            content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
          },
        ],
      });
      continue;
    }
    if (m.role === "assistant") {
      const parts: AnthropicMessage["content"] = [];
      if (m.content) {
        parts.push({ type: "text", text: String(m.content) });
      }
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          let input: Record<string, unknown> = {};
          try {
            input = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
          } catch {
            input = { _raw: tc.function?.arguments };
          }
          parts.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function?.name ?? "",
            input,
          });
        }
      }
      anthropic.push({
        role: "assistant",
        content: parts.length === 1 && parts[0]!.type === "text" ? (parts[0] as { type: "text"; text: string }).text : parts,
      });
      continue;
    }
    if (m.role === "user") {
      anthropic.push({
        role: "user",
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      });
    }
  }

  return { system, anthropic };
}

/**
 * Translate Anthropic response → OpenAI ChatCompletionResponse.
 */
function translateResponse(
  data: AnthropicResponse,
  model: string,
): ChatCompletionResponse {
  let text = "";
  const tool_calls: ToolCall[] = [];

  for (const part of data.content) {
    if (part.type === "text") {
      text += part.text;
    } else if (part.type === "tool_use") {
      tool_calls.push({
        id: part.id,
        type: "function",
        function: {
          name: part.name,
          arguments: JSON.stringify(part.input ?? {}),
        },
      });
    }
  }

  return {
    id: data.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: data.model || model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text || null,
          tool_calls: tool_calls.length > 0 ? tool_calls : undefined,
        },
        finish_reason:
          data.stop_reason === "tool_use"
            ? "tool_calls"
            : data.stop_reason === "max_tokens"
              ? "length"
              : "stop",
      },
    ],
    usage: data.usage
      ? {
          prompt_tokens: data.usage.input_tokens,
          completion_tokens: data.usage.output_tokens,
          total_tokens: data.usage.input_tokens + data.usage.output_tokens,
        }
      : undefined,
    _routed_via: { provider: "anthropic", model },
  };
}

export class AnthropicProvider extends Provider {
  readonly id = "anthropic";
  readonly name = "Anthropic";
  readonly defaultModel = "claude-haiku-4-5-20251001";

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    model: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    const { system, anthropic } = translateMessages(messages);

    const tools: AnthropicTool[] | undefined = options?.tools?.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: (t.function.parameters as Record<string, unknown>) ?? {
        type: "object",
        properties: {},
      },
    }));

    const body: Record<string, unknown> = {
      model,
      messages: anthropic,
      max_tokens: options?.max_tokens ?? 1024,
    };
    if (system) body.system = system;
    if (options?.temperature !== undefined) body.temperature = options.temperature;
    if (options?.top_p !== undefined) body.top_p = options.top_p;
    if (tools && tools.length > 0) body.tools = tools;
    if (options?.tool_choice) {
      // Anthropic shape:
      //   "auto"   → {type:"auto"}
      //   "required" → {type:"any"}
      //   {type:"function", function:{name}} → {type:"tool", name}
      if (options.tool_choice === "auto") body.tool_choice = { type: "auto" };
      else if (options.tool_choice === "required") body.tool_choice = { type: "any" };
      else if (typeof options.tool_choice === "object")
        body.tool_choice = { type: "tool", name: options.tool_choice.function.name };
    }

    const res = await this.fetchWithTimeout(API_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": API_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      this.httpError(res.status, raw);
    }

    const data = (await res.json()) as AnthropicResponse;
    return translateResponse(data, model);
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    model: string,
    options?: CompletionOptions,
  ): AsyncIterable<ChatCompletionChunk> {
    // Streaming is implemented as non-streaming then a single-chunk yield, for
    // brevity. A production-quality version would consume Anthropic's SSE
    // event stream. The router's primary need is chatCompletion() — this is a
    // graceful fallback.
    const resp = await this.chatCompletion(apiKey, messages, model, options);
    const choice = resp.choices[0]!;
    yield {
      id: resp.id,
      object: "chat.completion.chunk",
      created: resp.created,
      model: resp.model,
      choices: [
        {
          index: 0,
          delta: {
            content: typeof choice.message.content === "string" ? choice.message.content : null,
            tool_calls: choice.message.tool_calls,
          },
          finish_reason: choice.finish_reason,
        },
      ],
    };
  }
}
