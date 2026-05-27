/**
 * test/google-provider.test.ts
 *
 * Unit tests for src/providers/google.ts — GoogleProvider.
 * Mocks globalThis.fetch so no network is required.
 *
 * Tests cover:
 *   1. chatCompletion: system message → systemInstruction (joined)
 *   2. chatCompletion: user message → Gemini content with role "user"
 *   3. chatCompletion: functionCall part → OpenAI tool_calls shape
 *   4. chatCompletion: finish_reason "tool_calls" when tool calls present
 *   5. chatCompletion: HTTP error → throws with .status
 *   6. chatCompletion: MAX_TOKENS finishReason → "length"
 *   7. chatCompletion: tool message (functionResponse) resolved by tool_call_id lookup
 *   8. toGeminiToolConfig: "required" → mode "ANY"
 *   9. toGeminiToolConfig: named function → mode "ANY" with allowedFunctionNames
 *  10. streamChatCompletion: yields text delta chunks, then finish chunk
 *  11. streamChatCompletion: deduplicates tool calls across SSE chunks
 *  12. OpenRouterProvider: 200 with error body → throws httpError
 *  13. GroqProvider: sets Authorization Bearer header
 *  14. CerebrasProvider: sets Authorization Bearer header to Cerebras base URL
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GoogleProvider } from "../src/providers/google.js";
import { OpenRouterProvider } from "../src/providers/openrouter.js";
import { GroqProvider } from "../src/providers/groq.js";
import { CerebrasProvider } from "../src/providers/cerebras.js";

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

function mockFetchJson(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: { get: () => null },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    body: null,
  });
}

function mockFetchSse(chunks: string[]) {
  const encoder = new TextEncoder();
  const payload = chunks.join("") + "data: [DONE]\n\n";
  const bytes = encoder.encode(payload);
  let pos = 0;

  const reader = {
    read: vi.fn().mockImplementation(() => {
      if (pos < bytes.length) {
        const slice = bytes.slice(pos, pos + 128);
        pos += 128;
        return Promise.resolve({ done: false, value: slice });
      }
      return Promise.resolve({ done: true, value: undefined });
    }),
    cancel: vi.fn(),
  };

  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => null },
    json: () => Promise.reject(new Error("streaming")),
    text: () => Promise.reject(new Error("streaming")),
    body: { getReader: () => reader },
  });
}

// Minimal Gemini response with text only
function geminiTextResponse(text: string, finishReason = "STOP") {
  return {
    candidates: [{
      content: { parts: [{ text }] },
      finishReason,
    }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
  };
}

// Gemini response with a function call
function geminiFunctionCallResponse(fnName: string, args: Record<string, unknown>) {
  return {
    candidates: [{
      content: { parts: [{ functionCall: { id: "call_1", name: fnName, args } }] },
      finishReason: "STOP",
    }],
    usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 8, totalTokenCount: 28 },
  };
}

// ---------------------------------------------------------------------------
// Tests — GoogleProvider
// ---------------------------------------------------------------------------

describe("GoogleProvider.chatCompletion", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("sends system messages as systemInstruction (joined with \\n\\n)", async () => {
    globalThis.fetch = mockFetchJson(geminiTextResponse("hello"));
    const provider = new GoogleProvider();
    await provider.chatCompletion("key", [
      { role: "system", content: "You are helpful." },
      { role: "system", content: "Be concise." },
      { role: "user", content: "Hi" },
    ], "gemini-2.5-flash");

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.systemInstruction).toBeDefined();
    expect(body.systemInstruction.parts[0].text).toBe("You are helpful.\n\nBe concise.");
    // system messages should NOT appear in contents
    expect(body.contents.every((c: { role: string }) => c.role !== "system")).toBe(true);
  });

  it("maps user message to Gemini role 'user' with text part", async () => {
    globalThis.fetch = mockFetchJson(geminiTextResponse("pong"));
    const provider = new GoogleProvider();
    await provider.chatCompletion("key", [
      { role: "user", content: "ping" },
    ], "gemini-2.5-flash");

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.contents).toHaveLength(1);
    expect(body.contents[0].role).toBe("user");
    expect(body.contents[0].parts[0].text).toBe("ping");
  });

  it("maps Gemini functionCall part → OpenAI tool_calls shape", async () => {
    globalThis.fetch = mockFetchJson(geminiFunctionCallResponse("searchWeb", { query: "AI news" }));
    const provider = new GoogleProvider();
    const result = await provider.chatCompletion("key", [
      { role: "user", content: "Search for AI news" },
    ], "gemini-2.5-flash");

    const message = result.choices[0]!.message;
    expect(message.tool_calls).toHaveLength(1);
    expect(message.tool_calls![0]!.function.name).toBe("searchWeb");
    expect(JSON.parse(message.tool_calls![0]!.function.arguments)).toEqual({ query: "AI news" });
    expect(message.tool_calls![0]!.type).toBe("function");
  });

  it("sets finish_reason to 'tool_calls' when tool calls are present", async () => {
    globalThis.fetch = mockFetchJson(geminiFunctionCallResponse("click", { selector: "#btn" }));
    const provider = new GoogleProvider();
    const result = await provider.chatCompletion("key", [
      { role: "user", content: "Click the button" },
    ], "gemini-2.5-flash");

    expect(result.choices[0]!.finish_reason).toBe("tool_calls");
  });

  it("throws an error with .status when HTTP is not OK", async () => {
    globalThis.fetch = mockFetchJson({ error: "Unauthorized" }, 401);
    const provider = new GoogleProvider();
    const err = await provider
      .chatCompletion("badkey", [{ role: "user", content: "hi" }], "gemini-2.5-flash")
      .catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error & { status: number }).status).toBe(401);
    expect((err as Error).message).toContain("401");
  });

  it("maps MAX_TOKENS finishReason to 'length'", async () => {
    globalThis.fetch = mockFetchJson(geminiTextResponse("truncated...", "MAX_TOKENS"));
    const provider = new GoogleProvider();
    const result = await provider.chatCompletion("key", [
      { role: "user", content: "tell me everything" },
    ], "gemini-2.5-flash");

    expect(result.choices[0]!.finish_reason).toBe("length");
  });

  it("maps tool response messages (role=tool) to Gemini functionResponse parts", async () => {
    globalThis.fetch = mockFetchJson(geminiTextResponse("Got the results."));
    const provider = new GoogleProvider();
    await provider.chatCompletion("key", [
      { role: "user", content: "Search for AI news" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_abc",
          type: "function",
          function: { name: "searchWeb", arguments: '{"query":"AI"}' },
        }],
      },
      { role: "tool", tool_call_id: "call_abc", content: '{"results":["article1"]}' },
    ], "gemini-2.5-flash");

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    // Last content should be the tool response with functionResponse part
    const toolContent = body.contents.find(
      (c: { parts: Array<{ functionResponse?: unknown }> }) =>
        c.parts.some(p => p.functionResponse)
    );
    expect(toolContent).toBeDefined();
    const fr = toolContent.parts[0].functionResponse;
    expect(fr.name).toBe("searchWeb");
    expect(fr.id).toBe("call_abc");
  });

  it("sends tools as Gemini functionDeclarations", async () => {
    globalThis.fetch = mockFetchJson(geminiTextResponse("ok"));
    const provider = new GoogleProvider();
    await provider.chatCompletion("key", [{ role: "user", content: "hi" }], "gemini-2.5-flash", {
      tools: [{
        type: "function",
        function: { name: "myTool", description: "does a thing", parameters: { type: "object" } },
      }],
      tool_choice: "required",
    });

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.tools).toBeDefined();
    expect(body.tools[0].functionDeclarations[0].name).toBe("myTool");
    // "required" → Gemini mode "ANY"
    expect(body.toolConfig.functionCallingConfig.mode).toBe("ANY");
  });

  it("sends named-function tool_choice as mode ANY with allowedFunctionNames", async () => {
    globalThis.fetch = mockFetchJson(geminiTextResponse("ok"));
    const provider = new GoogleProvider();
    await provider.chatCompletion("key", [{ role: "user", content: "hi" }], "gemini-2.5-flash", {
      tools: [{
        type: "function",
        function: { name: "specificFn", description: "specific" },
      }],
      tool_choice: { type: "function", function: { name: "specificFn" } },
    });

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.toolConfig.functionCallingConfig.mode).toBe("ANY");
    expect(body.toolConfig.functionCallingConfig.allowedFunctionNames).toEqual(["specificFn"]);
  });

  it("sets _routed_via with provider=google and model", async () => {
    globalThis.fetch = mockFetchJson(geminiTextResponse("hi"));
    const provider = new GoogleProvider();
    const result = await provider.chatCompletion("key", [
      { role: "user", content: "hi" },
    ], "gemini-2.5-flash");

    expect(result._routed_via).toEqual({ provider: "google", model: "gemini-2.5-flash" });
  });
});

// ---------------------------------------------------------------------------
// Tests — GoogleProvider streaming
// ---------------------------------------------------------------------------

describe("GoogleProvider.streamChatCompletion", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("yields text delta chunks from SSE stream and emits finish chunk on [DONE]", async () => {
    const chunks = [
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "Hello" }] } }] })}\n\n`,
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: " world" }] } }] })}\n\n`,
    ];
    globalThis.fetch = mockFetchSse(chunks);

    const provider = new GoogleProvider();
    const collected: string[] = [];
    let finishChunk: unknown = null;

    for await (const chunk of provider.streamChatCompletion(
      "key",
      [{ role: "user", content: "hi" }],
      "gemini-2.5-flash",
    )) {
      if (chunk.choices[0]!.finish_reason !== null) {
        finishChunk = chunk;
      } else if (chunk.choices[0]!.delta.content) {
        collected.push(chunk.choices[0]!.delta.content);
      }
    }

    expect(collected.join("")).toBe("Hello world");
    expect(finishChunk).toBeDefined();
    expect((finishChunk as { choices: Array<{ finish_reason: string }> }).choices[0]!.finish_reason).toBe("stop");
  });

  it("deduplicates identical tool calls across multiple SSE chunks", async () => {
    const toolCallPart = {
      functionCall: { id: "call_dup", name: "myTool", args: { x: 1 } },
    };
    const chunkData = JSON.stringify({
      candidates: [{ content: { parts: [toolCallPart] } }],
    });
    // Emit the same tool call twice
    const chunks = [
      `data: ${chunkData}\n\n`,
      `data: ${chunkData}\n\n`,
    ];
    globalThis.fetch = mockFetchSse(chunks);

    const provider = new GoogleProvider();
    const toolCallChunks: unknown[] = [];

    for await (const chunk of provider.streamChatCompletion(
      "key",
      [{ role: "user", content: "go" }],
      "gemini-2.5-flash",
    )) {
      if (chunk.choices[0]!.delta.tool_calls?.length) {
        toolCallChunks.push(chunk);
      }
    }

    // Only one chunk should have the tool call (duplicate filtered)
    expect(toolCallChunks).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tests — OpenRouterProvider unique behavior
// ---------------------------------------------------------------------------

describe("OpenRouterProvider", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("throws httpError when HTTP 200 response contains error field", async () => {
    const body = {
      id: "cmpl-1",
      object: "chat.completion",
      created: 0,
      model: "deepseek/deepseek-r1:free",
      choices: [],
      error: { code: 429, message: "Rate limit exceeded" },
    };
    globalThis.fetch = mockFetchJson(body, 200);

    const provider = new OpenRouterProvider();
    const err = await provider
      .chatCompletion("key", [{ role: "user", content: "hi" }], "deepseek/deepseek-r1:free")
      .catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error & { status: number }).status).toBe(429);
    expect((err as Error).message).toContain("Rate limit exceeded");
  });

  it("sends HTTP-Referer and X-Title headers", async () => {
    const responseBody = {
      id: "cmpl-2", object: "chat.completion", created: 0,
      model: "deepseek/deepseek-r1:free",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    };
    globalThis.fetch = mockFetchJson(responseBody);

    const provider = new OpenRouterProvider({
      referer: "https://example.com",
      title: "TestApp",
    });
    await provider.chatCompletion("key", [{ role: "user", content: "hi" }], "deepseek/deepseek-r1:free");

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["HTTP-Referer"]).toBe("https://example.com");
    expect(headers["X-Title"]).toBe("TestApp");
  });

  it("uses default Referer/Title when no options provided", async () => {
    const responseBody = {
      id: "cmpl-3", object: "chat.completion", created: 0,
      model: "deepseek/deepseek-r1:free",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    };
    globalThis.fetch = mockFetchJson(responseBody);

    const provider = new OpenRouterProvider();
    await provider.chatCompletion("key", [{ role: "user", content: "hi" }], "deepseek/deepseek-r1:free");

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["HTTP-Referer"]).toContain("free-browser-agent");
    expect(headers["X-Title"]).toBe("Free Browser Agent");
  });

  it("sets _routed_via with provider=openrouter", async () => {
    const responseBody = {
      id: "cmpl-4", object: "chat.completion", created: 0,
      model: "moonshotai/kimi-k2:free",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    };
    globalThis.fetch = mockFetchJson(responseBody);

    const provider = new OpenRouterProvider();
    const result = await provider.chatCompletion(
      "key",
      [{ role: "user", content: "hi" }],
      "moonshotai/kimi-k2:free",
    );
    expect(result._routed_via).toEqual({ provider: "openrouter", model: "moonshotai/kimi-k2:free" });
  });
});

// ---------------------------------------------------------------------------
// Tests — GroqProvider + CerebrasProvider (OpenAI-compat thin wrappers)
// ---------------------------------------------------------------------------

describe("GroqProvider", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("sends Authorization Bearer header to Groq API base URL", async () => {
    const responseBody = {
      id: "cmpl-g1", object: "chat.completion", created: 0,
      model: "llama-3.3-70b-versatile",
      choices: [{ index: 0, message: { role: "assistant", content: "yo" }, finish_reason: "stop" }],
    };
    globalThis.fetch = mockFetchJson(responseBody);

    const provider = new GroqProvider();
    await provider.chatCompletion("groq-api-key", [{ role: "user", content: "hi" }], "llama-3.3-70b-versatile");

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toContain("api.groq.com");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer groq-api-key");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("sets _routed_via provider=groq", async () => {
    const responseBody = {
      id: "cmpl-g2", object: "chat.completion", created: 0,
      model: "llama-3.3-70b-versatile",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    };
    globalThis.fetch = mockFetchJson(responseBody);

    const provider = new GroqProvider();
    const result = await provider.chatCompletion(
      "key",
      [{ role: "user", content: "hi" }],
      "llama-3.3-70b-versatile",
    );
    expect(result._routed_via).toEqual({ provider: "groq", model: "llama-3.3-70b-versatile" });
  });

  it("throws with .status on 429 rate limit", async () => {
    globalThis.fetch = mockFetchJson({ error: "Rate limited" }, 429);

    const provider = new GroqProvider();
    const err = await provider
      .chatCompletion("key", [{ role: "user", content: "hi" }], "llama-3.3-70b-versatile")
      .catch(e => e);
    expect((err as Error & { status: number }).status).toBe(429);
  });
});

describe("CerebrasProvider", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("sends Authorization Bearer header to Cerebras API base URL", async () => {
    const responseBody = {
      id: "cmpl-c1", object: "chat.completion", created: 0,
      model: "qwen-3-235b",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    };
    globalThis.fetch = mockFetchJson(responseBody);

    const provider = new CerebrasProvider();
    await provider.chatCompletion("cerebras-key", [{ role: "user", content: "hi" }], "qwen-3-235b");

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toContain("api.cerebras.ai");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer cerebras-key");
  });

  it("sets _routed_via provider=cerebras", async () => {
    const responseBody = {
      id: "cmpl-c2", object: "chat.completion", created: 0,
      model: "qwen-3-235b",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    };
    globalThis.fetch = mockFetchJson(responseBody);

    const provider = new CerebrasProvider();
    const result = await provider.chatCompletion(
      "key",
      [{ role: "user", content: "hi" }],
      "qwen-3-235b",
    );
    expect(result._routed_via).toEqual({ provider: "cerebras", model: "qwen-3-235b" });
  });
});
