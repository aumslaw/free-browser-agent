/**
 * src/offscreen/offscreen.ts
 *
 * Offscreen document host for Chrome built-in AI (Gemini Nano) inference.
 *
 * The Chrome Prompt API (LanguageModel / self.ai.languageModel) is ONLY
 * available in window contexts (sidepanel, options, offscreen docs, content
 * scripts) — NOT in MV3 service workers.  This document acts as a thin proxy:
 * the service-worker router sends a `chrome-ai-infer` message here, we run
 * the inference, and return the result.
 *
 * Message shape (inbound from service worker):
 *   {
 *     kind: "chrome-ai-infer",
 *     messages: ChatMessage[],
 *     model: string,
 *     stream: false,   // streaming not yet supported across offscreen boundary
 *   }
 *
 * Response shape (sent back via sendResponse):
 *   { ok: true,  result: ChatCompletionResponse }
 *   { ok: false, error: string }
 */

import { ChromeAIProvider } from "../providers/chrome-ai.js";
import type { ChatMessage } from "../shared/types.js";

const provider = new ChromeAIProvider();

chrome.runtime.onMessage.addListener(
  (
    message: { kind?: string; messages?: ChatMessage[]; model?: string } & Record<string, unknown>,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ) => {
    if (message.kind !== "chrome-ai-infer") return false;

    const { messages = [], model = "gemini-nano" } = message;

    void (async () => {
      try {
        const result = await provider.chatCompletion(
          "" /* apiKey — chrome-ai is keyless */,
          messages,
          model,
        );
        sendResponse({ ok: true, result });
      } catch (err) {
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    return true; // keep message channel open for async sendResponse
  },
);
