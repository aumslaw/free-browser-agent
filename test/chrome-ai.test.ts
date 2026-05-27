/**
 * test/chrome-ai.test.ts
 *
 * Unit tests for src/providers/chrome-ai.ts -- ChromeAIProvider.
 *
 * Stubs globalThis.LanguageModel so no real Chrome Prompt API is required.
 *
 * Tests cover:
 *   1. isChromeAIAvailable() returns true when stub is present and availability() = "available"
 *   2. isChromeAIAvailable() returns false when global is absent
 *   3. chatCompletion() maps model output to the OpenAI ChatCompletionResponse shape
 *   4. streamChatCompletion() yields delta chunks whose content concatenates to the full reply
 *   5. isChromeAIAvailable() returns false when availability() says "unavailable"
 *   6. chatCompletion() handles system messages without throwing
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ChromeAIProvider, isChromeAIAvailable } from "../src/providers/chrome-ai.js";

// ---------------------------------------------------------------------------
// Stub factory
// ---------------------------------------------------------------------------

function makeStub(
  replyText: string,
  streamChunks: string[],
  availStatus: "available" | "downloadable" | "unavailable" = "available",
) {
  const session = {
    prompt: async (_text: string) => replyText,
    promptStreaming: async function* (_text: string): AsyncGenerator<string> {
      for (const chunk of streamChunks) {
        yield chunk;
      }
    },
    destroy: () => { /* no-op */ },
  };

  return {
    availability: async () => availStatus,
    create: async (_opts?: unknown) => session,
  };
}

// ---------------------------------------------------------------------------
// Helpers for installing / removing the global stub
// ---------------------------------------------------------------------------

let savedLM: unknown;

function installStub(
  text = "hello",
  chunks = ["he", "llo"],
  avail: "available" | "downloadable" | "unavailable" = "available",
) {
  savedLM = (globalThis as Record<string, unknown>)["LanguageModel"];
  (globalThis as Record<string, unknown>)["LanguageModel"] = makeStub(text, chunks, avail);
}

function removeStub() {
  if (savedLM === undefined) {
    delete (globalThis as Record<string, unknown>)["LanguageModel"];
  } else {
    (globalThis as Record<string, unknown>)["LanguageModel"] = savedLM;
    savedLM = undefined;
  }
}

// ---------------------------------------------------------------------------
// Tests -- isChromeAIAvailable
// ---------------------------------------------------------------------------

describe("isChromeAIAvailable", () => {
  afterEach(removeStub);

  it("returns true when LanguageModel stub is present and availability() = available", async () => {
    installStub("hi", ["hi"], "available");
    expect(await isChromeAIAvailable()).toBe(true);
  });

  it("returns false when LanguageModel global is absent", async () => {
    delete (globalThis as Record<string, unknown>)["LanguageModel"];
    expect(await isChromeAIAvailable()).toBe(false);
  });

  it("returns false when availability() = unavailable", async () => {
    installStub("hi", ["hi"], "unavailable");
    expect(await isChromeAIAvailable()).toBe(false);
  });

  it("returns true when availability() = downloadable", async () => {
    installStub("hi", ["hi"], "downloadable");
    expect(await isChromeAIAvailable()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests -- ChromeAIProvider.chatCompletion
// ---------------------------------------------------------------------------

describe("ChromeAIProvider.chatCompletion", () => {
  let provider: ChromeAIProvider;

  beforeEach(() => {
    provider = new ChromeAIProvider();
    installStub("hello", ["he", "llo"]);
  });

  afterEach(removeStub);

  it("returns an OpenAI-shaped ChatCompletionResponse with the model output", async () => {
    const result = await provider.chatCompletion(
      "",
      [{ role: "user", content: "say hello" }],
      "gemini-nano",
    );

    expect(result.object).toBe("chat.completion");
    expect(result.model).toBe("gemini-nano");
    expect(result.choices).toHaveLength(1);
    expect(result.choices[0]!.message.role).toBe("assistant");
    expect(result.choices[0]!.message.content).toBe("hello");
    expect(result.choices[0]!.finish_reason).toBe("stop");
    expect(result.id).toMatch(/^chatcmpl-/);
  });

  it("sets usage to zeros (on-device, no token counting)", async () => {
    const result = await provider.chatCompletion(
      "",
      [{ role: "user", content: "hi" }],
      "gemini-nano",
    );
    expect(result.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });

  it("sets _routed_via to chrome-ai", async () => {
    const result = await provider.chatCompletion(
      "",
      [{ role: "user", content: "hi" }],
      "gemini-nano",
    );
    expect(result._routed_via).toEqual({ provider: "chrome-ai", model: "gemini-nano" });
  });

  it("ignores the apiKey parameter (on-device, keyless)", async () => {
    const result = await provider.chatCompletion(
      "this-key-is-ignored",
      [{ role: "user", content: "hi" }],
      "gemini-nano",
    );
    expect(result.choices[0]!.message.content).toBe("hello");
  });

  it("handles system messages by passing them as initialPrompts", async () => {
    const result = await provider.chatCompletion(
      "",
      [
        { role: "system", content: "You are a pirate." },
        { role: "user", content: "Ahoy?" },
      ],
      "gemini-nano",
    );
    expect(result.choices[0]!.message.content).toBe("hello");
  });

  it("throws when the Prompt API is absent", async () => {
    removeStub();
    delete (globalThis as Record<string, unknown>)["LanguageModel"];
    await expect(
      provider.chatCompletion("", [{ role: "user", content: "hi" }], "gemini-nano"),
    ).rejects.toThrow("[chrome-ai]");
  });
});

// ---------------------------------------------------------------------------
// Tests -- ChromeAIProvider.streamChatCompletion
// ---------------------------------------------------------------------------

describe("ChromeAIProvider.streamChatCompletion", () => {
  let provider: ChromeAIProvider;

  beforeEach(() => {
    provider = new ChromeAIProvider();
    installStub("hello", ["he", "llo"]);
  });

  afterEach(removeStub);

  it("yields chunks whose delta.content concatenates to the full reply", async () => {
    const textParts: string[] = [];
    let lastFinishReason: string | null = null;

    for await (const chunk of provider.streamChatCompletion(
      "",
      [{ role: "user", content: "stream test" }],
      "gemini-nano",
    )) {
      if (chunk.choices[0]!.finish_reason !== null) {
        lastFinishReason = chunk.choices[0]!.finish_reason;
      } else if (chunk.choices[0]!.delta.content) {
        textParts.push(chunk.choices[0]!.delta.content);
      }
    }

    expect(textParts.join("")).toBe("hello");
    expect(lastFinishReason).toBe("stop");
  });

  it("all chunks share the same id and model", async () => {
    const ids = new Set<string>();
    const models = new Set<string>();

    for await (const chunk of provider.streamChatCompletion(
      "",
      [{ role: "user", content: "hi" }],
      "gemini-nano",
    )) {
      ids.add(chunk.id);
      models.add(chunk.model);
    }

    expect(ids.size).toBe(1);
    expect(models.has("gemini-nano")).toBe(true);
  });

  it("emits a final finish chunk with finish_reason=stop and empty delta", async () => {
    const finishChunks: unknown[] = [];

    for await (const chunk of provider.streamChatCompletion(
      "",
      [{ role: "user", content: "hi" }],
      "gemini-nano",
    )) {
      if (chunk.choices[0]!.finish_reason === "stop") {
        finishChunks.push(chunk);
      }
    }

    expect(finishChunks).toHaveLength(1);
    const fc = finishChunks[0] as { choices: Array<{ delta: unknown; finish_reason: string }> };
    expect(fc.choices[0]!.delta).toEqual({});
  });

  it("throws when the Prompt API is absent", async () => {
    removeStub();
    delete (globalThis as Record<string, unknown>)["LanguageModel"];

    const gen = provider.streamChatCompletion(
      "",
      [{ role: "user", content: "hi" }],
      "gemini-nano",
    );
    await expect(gen[Symbol.asyncIterator]().next()).rejects.toThrow("[chrome-ai]");
  });
});
