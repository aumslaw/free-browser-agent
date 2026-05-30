/**
 * providers/chrome-ai.ts
 *
 * Chrome built-in AI (Gemini Nano) provider adapter.
 *
 * Uses the Chrome Prompt API (LanguageModel / self.ai.languageModel) -- no API
 * key required, fully on-device.  Supports both the newer top-level
 * `LanguageModel` global (Chrome 127+ origin-trial/flag) and the older
 * `self.ai.languageModel` surface.
 *
 * IMPORTANT: The Prompt API is only available in contexts that can access the
 * window/self global (side-panel, options page, offscreen document, content
 * script).  It is NOT available inside a Service Worker (MV3 background).  If
 * the router dispatches to chrome-ai from the background worker it must proxy
 * the call through an offscreen document or the sidepanel.
 * `isChromeAIAvailable()` returns false in SW contexts.
 */

import { Provider } from "./base.js";
import type {
  CompletionOptions,
  ChatCompletionResponse,
  ChatCompletionChunk,
} from "./base.js";
import type { ChatMessage } from "@/shared/types.js";

// ---------------------------------------------------------------------------
// Prompt API type shims (not in @types/chrome yet)
// ---------------------------------------------------------------------------

interface LanguageModelSession {
  prompt(text: string): Promise<string>;
  promptStreaming(text: string): AsyncIterable<string>;
  destroy?(): void;
}

type LanguageModelAvailability = "available" | "downloadable" | "unavailable";

interface LanguageModelCreateOptions {
  initialPrompts?: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  temperature?: number;
  topK?: number;
}

interface LanguageModelStatic {
  availability?(): Promise<LanguageModelAvailability>;
  capabilities?(): Promise<{ available: LanguageModelAvailability }>;
  create(options?: LanguageModelCreateOptions): Promise<LanguageModelSession>;
}

// ---------------------------------------------------------------------------
// Feature detection
// ---------------------------------------------------------------------------

/**
 * Probes both the newer LanguageModel global and the older self.ai.languageModel
 * surface.  Returns null if neither is present.
 */
function getLanguageModelAPI(): LanguageModelStatic | null {
  try {
    const g = globalThis as Record<string, unknown>;
    if (g["LanguageModel"] != null) {
      return g["LanguageModel"] as LanguageModelStatic;
    }
    const selfAny = (typeof self !== "undefined" ? self : globalThis) as Record<string, unknown>;
    const ai = selfAny["ai"] as Record<string, unknown> | undefined;
    if (ai?.["languageModel"] != null) {
      return ai["languageModel"] as LanguageModelStatic;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Returns true if Gemini Nano is available (or downloadable) in the current context.
 * Never throws -- returns false on any error.
 *
 * When no availability/capabilities API is present on the LanguageModel global,
 * we probe a short-timeout session creation rather than blindly returning true.
 * In Playwright's headless Chromium the LanguageModel global may be present but
 * Gemini Nano is not installed; without the probe the router would select chrome-ai
 * first and then hang indefinitely in dispatchChromeAIViaOffscreen waiting for an
 * offscreen document that can never respond.
 */
export async function isChromeAIAvailable(): Promise<boolean> {
  try {
    const lm = getLanguageModelAPI();
    if (lm == null) return false;

    if (typeof lm.availability === "function") {
      const status = await lm.availability();
      return status !== "unavailable";
    }

    if (typeof lm.capabilities === "function") {
      const caps = await lm.capabilities();
      return caps.available !== "unavailable";
    }

    // API exists but has no availability/capabilities check.
    // Probe a session creation with a 2s timeout; treat any error or timeout
    // as "not available" to avoid hanging the router in headless/test environments.
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 2000);
      lm.create({}).then(
        (session) => {
          clearTimeout(timer);
          session.destroy?.();
          resolve(true);
        },
        () => {
          clearTimeout(timer);
          resolve(false);
        },
      );
    });
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Message flattening
// ---------------------------------------------------------------------------

interface FlattenResult {
  conversationText: string;
  initialPrompts: Array<{ role: "system" | "user" | "assistant"; content: string }>;
}

function flattenMessages(messages: ChatMessage[]): FlattenResult {
  const systemParts: string[] = [];
  const conversationParts: string[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemParts.push(typeof msg.content === "string" ? msg.content : String(msg.content));
    } else if (msg.role === "user") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
          ? msg.content.map((p) => ("text" in p ? p.text : "[image]")).join(" ")
          : String(msg.content);
      conversationParts.push(`user: ${text}`);
    } else if (msg.role === "assistant") {
      conversationParts.push(`assistant: ${msg.content ?? "(no content)"}`);
    } else if (msg.role === "tool") {
      conversationParts.push(`tool_result: ${msg.content}`);
    }
  }

  const initialPrompts: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
  if (systemParts.length > 0) {
    initialPrompts.push({ role: "system", content: systemParts.join("\n\n") });
  }

  return {
    conversationText: conversationParts.join("\n"),
    initialPrompts,
  };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class ChromeAIProvider extends Provider {
  readonly id = "chrome-ai";
  readonly name = "Chrome AI (Gemini Nano)";
  readonly defaultModel = "gemini-nano";

  async chatCompletion(
    _apiKey: string,
    messages: ChatMessage[],
    model: string,
    _options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    const lm = getLanguageModelAPI();
    if (lm == null) {
      throw new Error("[chrome-ai] Chrome Prompt API not available in this context");
    }

    const { conversationText, initialPrompts } = flattenMessages(messages);
    const session = await lm.create({ initialPrompts });
    let output: string;
    try {
      output = await session.prompt(conversationText);
    } finally {
      session.destroy?.();
    }

    return {
      id: this.makeId(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: output },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      _routed_via: { provider: this.id, model },
    };
  }

  async *streamChatCompletion(
    _apiKey: string,
    messages: ChatMessage[],
    model: string,
    _options?: CompletionOptions,
  ): AsyncIterable<ChatCompletionChunk> {
    const lm = getLanguageModelAPI();
    if (lm == null) {
      throw new Error("[chrome-ai] Chrome Prompt API not available in this context");
    }

    const { conversationText, initialPrompts } = flattenMessages(messages);
    const session = await lm.create({ initialPrompts });
    const id = this.makeId();
    const now = Math.floor(Date.now() / 1000);

    try {
      for await (const textDelta of session.promptStreaming(conversationText)) {
        yield {
          id,
          object: "chat.completion.chunk",
          created: now,
          model,
          choices: [{ index: 0, delta: { content: textDelta }, finish_reason: null }],
        };
      }
      // final finish chunk
      yield {
        id,
        object: "chat.completion.chunk",
        created: now,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      };
    } finally {
      session.destroy?.();
    }
  }
}
