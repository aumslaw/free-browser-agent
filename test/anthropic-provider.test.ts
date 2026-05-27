/**
 * test/anthropic-provider.test.ts
 *
 * Unit tests for src/providers/anthropic.ts — AnthropicProvider.
 *
 * Tests cover:
 *   1. translateMessages: system prompt extraction (multiple system messages merged)
 *   2. translateMessages: tool-role → tool_result wrapping
 *   3. translateMessages: assistant + tool_calls → tool_use content parts
 *   4. translateMessages: assistant with bad JSON args — _raw fallback
 *   5. chatCompletion: happy path — text response translated to OpenAI shape
 *   6. chatCompletion: tool_use response translated correctly
 *   7. chatCompletion: HTTP 401 throws a status-annotated error
 *   8. chatCompletion: tool_choice "required" → Anthropic {type:"any"}
 *   9. chatCompletion: tool_choice named function → {type:"tool", name}
 *  10. streamChatCompletion: yields a single chunk wrapping the chatCompletion response
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import type { ChatMessage } from "../src/shared/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a realistic Anthropic API response. */
function makeAnthropicResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_test_001",
    model: "claude-haiku-4-5-20251001",
    role: "assistant",
    content: [{ type: "text", text: "Hello from Anthropic!" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5 },
    ...overrides,
  };
}

/** Mock globalThis.fetch for a successful Anthropic JSON response. */
function mockFetchOk(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

/** Mock globalThis.fetch for an error HTTP response. */
function mockFetchError(status: number, body = "") {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    statusText: "Error",
    json: () => Promise.reject(new SyntaxError("not json")),
    text: () => Promise.resolve(body),
  });
}

// ---------------------------------------------------------------------------
// AnthropicProvider.chatCompletion
// ---------------------------------------------------------------------------

describe("AnthropicProvider.chatCompletion", () => {
  let provider: AnthropicProvider;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    provider = new AnthropicProvider();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("extracts multiple system messages and merges them with double-newline", async () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "system", content: "Respond concisely." },
      { role: "user", content: "Hi" },
    ];

    globalThis.fetch = mockFetchOk(makeAnthropicResponse());

    await provider.chatCompletion("sk-ant-test", messages, "claude-haiku-4-5-20251001");

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);

    expect(body.system).toBe("You are a helpful assistant.\n\nRespond concisely.");
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user");
  });

  it("translates role:tool messages into Anthropic tool_result blocks", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Use the calculator" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "tc_001",
          type: "function",
          function: { name: "calculate", arguments: '{"x":2,"y":3}' },
        }],
      },
      {
        role: "tool",
        tool_call_id: "tc_001",
        content: "5",
      },
    ];

    globalThis.fetch = mockFetchOk(makeAnthropicResponse());

    await provider.chatCompletion("sk-ant-test", messages, "claude-haiku-4-5-20251001");

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);

    const toolResultMsg = body.messages.find(
      (m: { role: string; content: Array<{ type: string; tool_use_id?: string; content?: string }> }) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        m.content[0]?.type === "tool_result"
    );
    expect(toolResultMsg).toBeDefined();
    expect(toolResultMsg.content[0].tool_use_id).toBe("tc_001");
    expect(toolResultMsg.content[0].content).toBe("5");
  });

  it("translates assistant tool_calls into Anthropic tool_use content parts", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Call the search function" },
      {
        role: "assistant",
        content: "Sure, searching now",
        tool_calls: [{
          id: "tc_002",
          type: "function",
          function: { name: "search", arguments: '{"query":"vitest"}' },
        }],
      },
    ];

    globalThis.fetch = mockFetchOk(makeAnthropicResponse());

    await provider.chatCompletion("sk-ant-test", messages, "claude-haiku-4-5-20251001");

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);

    const assistantMsg = body.messages.find((m: { role: string }) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    const parts = assistantMsg.content as Array<{ type: string; id?: string; name?: string; input?: unknown }>;
    const textPart = parts.find((p: { type: string }) => p.type === "text");
    const toolUsePart = parts.find((p: { type: string }) => p.type === "tool_use");
    expect(textPart).toBeDefined();
    expect(toolUsePart).toBeDefined();
    expect(toolUsePart!.id).toBe("tc_002");
    expect(toolUsePart!.name).toBe("search");
    expect(toolUsePart!.input).toEqual({ query: "vitest" });
  });

  it("falls back to {_raw: ...} when assistant tool_calls.arguments is not valid JSON", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Use tool" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "tc_bad",
          type: "function",
          function: { name: "broken_tool", arguments: "not-json-at-all" },
        }],
      },
    ];

    globalThis.fetch = mockFetchOk(makeAnthropicResponse());

    await provider.chatCompletion("sk-ant-test", messages, "claude-haiku-4-5-20251001");

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);

    const assistantMsg = body.messages.find((m: { role: string }) => m.role === "assistant");
    const parts = assistantMsg.content as Array<{ type: string; input?: Record<string, unknown> }>;
    const toolUsePart = parts.find((p: { type: string }) => p.type === "tool_use");
    expect(toolUsePart).toBeDefined();
    expect(toolUsePart!.input).toEqual({ _raw: "not-json-at-all" });
  });

  it("translates a text Anthropic response into an OpenAI ChatCompletionResponse", async () => {
    const anthropicResp = makeAnthropicResponse({
      content: [{ type: "text", text: "The answer is 42." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 8, output_tokens: 6 },
    });

    globalThis.fetch = mockFetchOk(anthropicResp);

    const result = await provider.chatCompletion(
      "sk-ant-test",
      [{ role: "user", content: "What is the answer?" }],
      "claude-haiku-4-5-20251001"
    );

    expect(result.id).toBe("msg_test_001");
    expect(result.object).toBe("chat.completion");
    expect(result.model).toBe("claude-haiku-4-5-20251001");
    expect(result.choices).toHaveLength(1);
    expect(result.choices[0]!.message.role).toBe("assistant");
    expect(result.choices[0]!.message.content).toBe("The answer is 42.");
    expect(result.choices[0]!.message.tool_calls).toBeUndefined();
    expect(result.choices[0]!.finish_reason).toBe("stop");
    expect(result.usage!.prompt_tokens).toBe(8);
    expect(result.usage!.completion_tokens).toBe(6);
    expect(result.usage!.total_tokens).toBe(14);
    expect(result._routed_via).toEqual({ provider: "anthropic", model: "claude-haiku-4-5-20251001" });
  });

  it("translates Anthropic tool_use response into OpenAI tool_calls", async () => {
    const anthropicResp = makeAnthropicResponse({
      content: [
        {
          type: "tool_use",
          id: "toolu_01abc",
          name: "get_weather",
          input: { location: "San Francisco" },
        },
      ],
      stop_reason: "tool_use",
    });

    globalThis.fetch = mockFetchOk(anthropicResp);

    const result = await provider.chatCompletion(
      "sk-ant-test",
      [{ role: "user", content: "What is the weather?" }],
      "claude-haiku-4-5-20251001"
    );

    expect(result.choices[0]!.finish_reason).toBe("tool_calls");
    // When there is no text part, translateResponse returns null (text || null)
    expect(result.choices[0]!.message.content).toBeNull();
    const toolCalls = result.choices[0]!.message.tool_calls!;
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.id).toBe("toolu_01abc");
    expect(toolCalls[0]!.type).toBe("function");
    expect(toolCalls[0]!.function.name).toBe("get_weather");
    expect(JSON.parse(toolCalls[0]!.function.arguments)).toEqual({ location: "San Francisco" });
  });

  it("throws an error with .status property on non-OK HTTP response", async () => {
    globalThis.fetch = mockFetchError(401, "Unauthorized — invalid API key");

    await expect(
      provider.chatCompletion(
        "sk-ant-invalid",
        [{ role: "user", content: "hi" }],
        "claude-haiku-4-5-20251001"
      )
    ).rejects.toMatchObject({
      status: 401,
      message: expect.stringContaining("401"),
    });
  });

  it("maps tool_choice 'required' to Anthropic {type:'any'}", async () => {
    globalThis.fetch = mockFetchOk(makeAnthropicResponse());

    await provider.chatCompletion(
      "sk-ant-test",
      [{ role: "user", content: "use a tool" }],
      "claude-haiku-4-5-20251001",
      {
        tools: [{ type: "function", function: { name: "my_tool", parameters: {} } }],
        tool_choice: "required",
      }
    );

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);

    expect(body.tool_choice).toEqual({ type: "any" });
  });

  it("maps tool_choice {type:'function', function:{name}} to {type:'tool', name}", async () => {
    globalThis.fetch = mockFetchOk(makeAnthropicResponse());

    await provider.chatCompletion(
      "sk-ant-test",
      [{ role: "user", content: "use a specific tool" }],
      "claude-haiku-4-5-20251001",
      {
        tools: [{ type: "function", function: { name: "specific_fn", parameters: {} } }],
        tool_choice: { type: "function", function: { name: "specific_fn" } },
      }
    );

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);

    expect(body.tool_choice).toEqual({ type: "tool", name: "specific_fn" });
  });
});

// ---------------------------------------------------------------------------
// AnthropicProvider.streamChatCompletion
// ---------------------------------------------------------------------------

describe("AnthropicProvider.streamChatCompletion", () => {
  let provider: AnthropicProvider;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    provider = new AnthropicProvider();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("yields a single ChatCompletionChunk wrapping the chatCompletion result", async () => {
    const anthropicResp = makeAnthropicResponse({
      id: "msg_stream_001",
      content: [{ type: "text", text: "Streamed reply" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 3, output_tokens: 2 },
    });

    globalThis.fetch = mockFetchOk(anthropicResp);

    const chunks: Array<{
      id: string;
      choices: Array<{ delta: { content?: string | null }; finish_reason: string | null }>;
    }> = [];

    for await (const chunk of provider.streamChatCompletion(
      "sk-ant-test",
      [{ role: "user", content: "stream test" }],
      "claude-haiku-4-5-20251001"
    )) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.id).toBe("msg_stream_001");
    expect(chunks[0]!.choices[0]!.delta.content).toBe("Streamed reply");
    expect(chunks[0]!.choices[0]!.finish_reason).toBe("stop");
  });
});
