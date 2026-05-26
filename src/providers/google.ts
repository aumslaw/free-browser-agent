/**
 * providers/google.ts
 *
 * Gemini 2.5 Flash via Google AI Studio.
 * Translates OpenAI tool-call shapes ↔ Gemini functionDeclarations/functionCall.
 */

import { Provider } from "./base.js";
import type {
  CompletionOptions,
  ToolDefinition,
  ToolChoice,
  ChatCompletionResponse,
  ChatCompletionChunk,
} from "./base.js";
import type { ChatMessage, ToolCall } from "@/shared/types.js";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

// ---------------------------------------------------------------------------
// Gemini wire types
// ---------------------------------------------------------------------------

interface GeminiPart {
  text?: string;
  functionCall?: {
    id?: string;
    name?: string;
    args?: unknown;
  };
  functionResponse?: {
    id?: string;
    name?: string;
    response?: unknown;
  };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiCandidate {
  content?: { parts?: GeminiPart[] };
  finishReason?: string;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeParseObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { value: raw };
  }
}

function normalizeArgs(args: unknown): string {
  if (typeof args === "string") return args;
  return JSON.stringify(args ?? {});
}

function toGeminiFinishReason(reason?: string): "stop" | "length" | "content_filter" {
  const r = (reason ?? "").toUpperCase();
  if (r === "MAX_TOKENS") return "length";
  if (["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII"].includes(r)) {
    return "content_filter";
  }
  return "stop";
}

/** Convert OpenAI tools[] → Gemini functionDeclarations wrapper. */
function toGeminiTools(tools?: ToolDefinition[]) {
  if (!tools || tools.length === 0) return undefined;
  return [{
    functionDeclarations: tools.map(t => ({
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    })),
  }];
}

/** Convert OpenAI tool_choice → Gemini toolConfig. */
function toGeminiToolConfig(toolChoice?: ToolChoice) {
  if (!toolChoice) return undefined;
  if (typeof toolChoice === "string") {
    const mode =
      toolChoice === "none" ? "NONE" :
      toolChoice === "required" ? "ANY" :
      "AUTO";
    return { functionCallingConfig: { mode } };
  }
  return {
    functionCallingConfig: {
      mode: "ANY",
      allowedFunctionNames: [toolChoice.function.name],
    },
  };
}

/**
 * Convert OpenAI message array → Gemini contents + optional systemInstruction.
 * Rules:
 *  - system messages → systemInstruction (joined)
 *  - assistant messages → role:"model" with text + functionCall parts
 *  - tool messages → role:"user" with functionResponse parts
 *  - user messages → role:"user" with text parts
 */
function toGeminiContents(messages: ChatMessage[]): {
  contents: GeminiContent[];
  systemInstruction?: { parts: GeminiPart[] };
} {
  const systemParts = messages
    .filter(m => m.role === "system")
    .map(m => (m as { role: "system"; content: string }).content)
    .filter(Boolean);

  // Build a lookup: tool_call_id → function name (needed for functionResponse)
  const toolNameByCallId = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) {
        toolNameByCallId.set(tc.id, tc.function.name);
      }
    }
  }

  const contents: GeminiContent[] = [];

  for (const m of messages) {
    if (m.role === "system") continue;

    if (m.role === "assistant") {
      const parts: GeminiPart[] = [];
      if (typeof m.content === "string" && m.content.length > 0) {
        parts.push({ text: m.content });
      }
      for (const tc of m.tool_calls ?? []) {
        parts.push({
          functionCall: {
            id: tc.id,
            name: tc.function.name,
            args: safeParseObject(tc.function.arguments),
          },
        });
      }
      if (parts.length === 0) continue;
      contents.push({ role: "model", parts });
      continue;
    }

    if (m.role === "tool") {
      const tm = m as { role: "tool"; tool_call_id: string; content: string };
      const toolName = toolNameByCallId.get(tm.tool_call_id) ?? "tool";
      contents.push({
        role: "user",
        parts: [{
          functionResponse: {
            id: tm.tool_call_id,
            name: toolName,
            response: safeParseObject(tm.content),
          },
        }],
      });
      continue;
    }

    // user message
    const um = m as { role: "user"; content: string | unknown[] };
    const text =
      typeof um.content === "string"
        ? um.content
        : (um.content as Array<{ type: string; text?: string }>)
            .filter(p => p.type === "text")
            .map(p => p.text ?? "")
            .join("");
    contents.push({ role: "user", parts: [{ text }] });
  }

  return {
    contents,
    systemInstruction: systemParts.length > 0
      ? { parts: [{ text: systemParts.join("\n\n") }] }
      : undefined,
  };
}

function extractToolCalls(parts?: GeminiPart[]): ToolCall[] {
  if (!parts) return [];
  const calls: ToolCall[] = [];
  let i = 0;
  for (const part of parts) {
    if (!part.functionCall?.name) continue;
    calls.push({
      id: part.functionCall.id ?? `call_${Date.now()}_${i++}`,
      type: "function",
      function: {
        name: part.functionCall.name,
        arguments: normalizeArgs(part.functionCall.args),
      },
    });
  }
  return calls;
}

function extractText(parts?: GeminiPart[]): string | null {
  if (!parts) return null;
  const text = parts.map(p => p.text ?? "").join("");
  return text.length > 0 ? text : null;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class GoogleProvider extends Provider {
  readonly id = "google";
  readonly name = "Google AI Studio";
  readonly defaultModel = "gemini-2.5-flash";

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    model: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    const { contents, systemInstruction } = toGeminiContents(messages);

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature: options?.temperature,
        maxOutputTokens: options?.max_tokens,
        topP: options?.top_p,
      },
      tools: toGeminiTools(options?.tools),
      toolConfig: toGeminiToolConfig(options?.tool_choice),
    };
    if (systemInstruction) body.systemInstruction = systemInstruction;

    const url = `${API_BASE}/models/${model}:generateContent?key=${apiKey}`;
    const res = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      this.httpError(res.status, raw);
    }

    const data = await res.json() as GeminiResponse;
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts;
    const toolCalls = extractToolCalls(parts);
    const text = extractText(parts);

    return {
      id: this.makeId(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: text,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls.length > 0 ? "tool_calls" : toGeminiFinishReason(candidate?.finishReason),
      }],
      usage: {
        prompt_tokens: data.usageMetadata?.promptTokenCount ?? 0,
        completion_tokens: data.usageMetadata?.candidatesTokenCount ?? 0,
        total_tokens: data.usageMetadata?.totalTokenCount ?? 0,
      },
      _routed_via: { provider: "google", model },
    };
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    model: string,
    options?: CompletionOptions,
  ): AsyncIterable<ChatCompletionChunk> {
    const { contents, systemInstruction } = toGeminiContents(messages);

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature: options?.temperature,
        maxOutputTokens: options?.max_tokens,
        topP: options?.top_p,
      },
      tools: toGeminiTools(options?.tools),
      toolConfig: toGeminiToolConfig(options?.tool_choice),
    };
    if (systemInstruction) body.systemInstruction = systemInstruction;

    const url = `${API_BASE}/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;
    const res = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, 30_000);

    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      this.httpError(res.status, raw);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error("[google] No response body");

    const decoder = new TextDecoder();
    const id = this.makeId();
    let buffer = "";
    let emittedFinish = false;
    let sawToolCalls = false;
    const seenToolKeys = new Set<string>();

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
        if (raw === "[DONE]") {
          if (!emittedFinish) {
            emittedFinish = true;
            yield {
              id, object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000), model,
              choices: [{ index: 0, delta: {}, finish_reason: sawToolCalls ? "tool_calls" : "stop" }],
            };
          }
          return;
        }

        let chunk: GeminiResponse;
        try { chunk = JSON.parse(raw) as GeminiResponse; } catch { continue; }

        const candidate = chunk.candidates?.[0];
        const parts = candidate?.content?.parts ?? [];
        const text = extractText(parts);
        const toolCalls = extractToolCalls(parts).filter(tc => {
          const key = `${tc.id}:${tc.function.name}:${tc.function.arguments}`;
          if (seenToolKeys.has(key)) return false;
          seenToolKeys.add(key);
          return true;
        });

        if (text || toolCalls.length > 0) {
          sawToolCalls = sawToolCalls || toolCalls.length > 0;
          yield {
            id, object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000), model,
            choices: [{
              index: 0,
              delta: {
                ...(text ? { content: text } : {}),
                ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
              },
              finish_reason: null,
            }],
          };
        }

        if (candidate?.finishReason && !emittedFinish) {
          emittedFinish = true;
          yield {
            id, object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000), model,
            choices: [{ index: 0, delta: {}, finish_reason: sawToolCalls ? "tool_calls" : toGeminiFinishReason(candidate.finishReason) }],
          };
          return;
        }
      }
    }

    if (!emittedFinish) {
      yield {
        id, object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, delta: {}, finish_reason: sawToolCalls ? "tool_calls" : "stop" }],
      };
    }
  }
}
