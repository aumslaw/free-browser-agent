/**
 * test/agent-loop.test.ts
 *
 * Unit tests for src/background/agent-loop.ts — runAgentLoop().
 *
 * Mocks:
 *   - chrome.tabs.sendMessage (DOM op dispatch to content script)
 *   - cdp.ts module (screenshot / dispatchClick / typeText)
 *   - Router interface (injected — no real LLM calls)
 *
 * Tests cover:
 *   1. Single-turn loop: LLM returns final answer (no tool_calls) → returns immediately
 *   2. Tool call dispatched: sendMessage called, tool result appended to messages
 *   3. Iteration cap: loop terminates after MAX_ITERATIONS (20) with synthetic message
 *   4. LLM error: error caught, synthetic error message returned, loop terminates
 *   5. Unknown tool: returns {ok:false, error:"Unknown tool: ..."}
 *   6. Bad JSON in tool arguments: returns {ok:false, error:"Invalid JSON..."}
 *   7. CDP escalation for click: sendMessage returns escalate:"cdp" → CDP click dispatched
 *   8. CDP escalation fails (coords not resolved): error message returned
 *   9. CDP escalation for type: typeText called
 *  10. Screenshot tool: cdp.screenshot called, data_uri in result
 *  11. onStatus callback fired with correct iter and action
 *  12. Content script returns {ok:false} without escalate — result forwarded as-is
 *  13. sendMessage throws → graceful error returned, loop continues
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock chrome.tabs before any imports that reference it
// ---------------------------------------------------------------------------

const tabsSendMessage = vi.fn();

(globalThis as Record<string, unknown>).chrome = {
  tabs: {
    sendMessage: tabsSendMessage,
  },
};

// ---------------------------------------------------------------------------
// Mock cdp.ts — use vi.hoisted() so refs are available before vi.mock() runs
// ---------------------------------------------------------------------------

const { mockScreenshot, mockDispatchClick, mockTypeText } = vi.hoisted(() => ({
  mockScreenshot: vi.fn().mockResolvedValue({ data: "base64imgdata", format: "png" }),
  mockDispatchClick: vi.fn().mockResolvedValue(undefined),
  mockTypeText: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/background/cdp.js", () => ({
  screenshot: mockScreenshot,
  dispatchClick: mockDispatchClick,
  typeText: mockTypeText,
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import { runAgentLoop } from "../src/background/agent-loop.js";
import type { Router } from "../src/background/agent-loop.js";
import type { ChatMessage } from "../src/shared/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRouter(responses: Array<{
  message: { role: "assistant"; content: string | null; tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }> };
  providerUsed: string;
}>): Router {
  let callCount = 0;
  return {
    chatCompletion: vi.fn().mockImplementation(async () => {
      const response = responses[callCount] ?? responses[responses.length - 1]!;
      callCount++;
      return response;
    }),
  };
}

function makeErrorRouter(error: Error): Router {
  return {
    chatCompletion: vi.fn().mockRejectedValue(error),
  };
}

function baseMessages(): ChatMessage[] {
  return [{ role: "user", content: "Do something on the page" }];
}

function clearMocks() {
  tabsSendMessage.mockReset();
  mockScreenshot.mockReset();
  mockScreenshot.mockResolvedValue({ data: "base64imgdata", format: "png" });
  mockDispatchClick.mockReset();
  mockDispatchClick.mockResolvedValue(undefined);
  mockTypeText.mockReset();
  mockTypeText.mockResolvedValue(undefined);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runAgentLoop — final answer (no tools)", () => {
  beforeEach(clearMocks);

  it("returns the assistant message immediately when no tool_calls", async () => {
    const router = makeRouter([{
      message: { role: "assistant", content: "Here is your answer." },
      providerUsed: "groq",
    }]);
    const messages = baseMessages();
    const statuses: unknown[] = [];

    const result = await runAgentLoop({
      messages,
      tools: [],
      tabId: 1,
      router,
      onStatus: s => statuses.push(s),
    });

    expect(result.content).toBe("Here is your answer.");
    expect(result.role).toBe("assistant");
    // Message appended to history
    expect(messages).toHaveLength(2);
    expect(messages[1]!.role).toBe("assistant");
    // Status emitted once with "final answer"
    expect(statuses).toHaveLength(1);
    expect((statuses[0] as { action: string }).action).toBe("final answer");
  });
});

describe("runAgentLoop — tool dispatch", () => {
  beforeEach(clearMocks);

  it("dispatches a DOM op via sendMessage and appends tool result to messages", async () => {
    tabsSendMessage.mockResolvedValueOnce({ ok: true, text: "page content here" });

    const router = makeRouter([
      // Turn 1: LLM wants to readPage
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "readPage", arguments: "{}" },
          }],
        },
        providerUsed: "groq",
      },
      // Turn 2: LLM gives final answer after seeing the page
      {
        message: { role: "assistant", content: "The page says: page content here" },
        providerUsed: "groq",
      },
    ]);

    const messages = baseMessages();
    const result = await runAgentLoop({
      messages,
      tools: [],
      tabId: 42,
      router,
      onStatus: () => {},
    });

    // sendMessage called with the DOM op
    expect(tabsSendMessage).toHaveBeenCalledOnce();
    const [calledTabId, calledMsg] = tabsSendMessage.mock.calls[0]!;
    expect(calledTabId).toBe(42);
    expect((calledMsg as { kind: string }).kind).toBe("dom-op");
    expect((calledMsg as { payload: { op: string } }).payload.op).toBe("readPage");

    // Tool result appended as role:"tool"
    const toolMsg = messages.find(m => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect((toolMsg as { tool_call_id: string }).tool_call_id).toBe("call_1");
    const content = JSON.parse((toolMsg as { content: string }).content);
    expect(content.ok).toBe(true);

    // Final answer returned
    expect(result.content).toContain("page content here");
  });

  it("dispatches screenshot tool via CDP (not sendMessage)", async () => {
    const router = makeRouter([
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_ss",
            type: "function",
            function: { name: "screenshot", arguments: "{}" },
          }],
        },
        providerUsed: "groq",
      },
      {
        message: { role: "assistant", content: "Screenshot taken." },
        providerUsed: "groq",
      },
    ]);

    const messages = baseMessages();
    await runAgentLoop({ messages, tools: [], tabId: 7, router, onStatus: () => {} });

    expect(mockScreenshot).toHaveBeenCalledOnce();
    expect(tabsSendMessage).not.toHaveBeenCalled();

    const toolMsg = messages.find(m => m.role === "tool");
    const content = JSON.parse((toolMsg as { content: string }).content);
    expect(content.ok).toBe(true);
    expect(content.data_uri).toContain("data:image/png;base64,base64imgdata");
  });

  it("returns unknown tool error for unrecognized tool names", async () => {
    const router = makeRouter([
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_unk",
            type: "function",
            function: { name: "teleport", arguments: "{}" },
          }],
        },
        providerUsed: "groq",
      },
      {
        message: { role: "assistant", content: "Could not teleport." },
        providerUsed: "groq",
      },
    ]);

    const messages = baseMessages();
    await runAgentLoop({ messages, tools: [], tabId: 1, router, onStatus: () => {} });

    const toolMsg = messages.find(m => m.role === "tool");
    const content = JSON.parse((toolMsg as { content: string }).content);
    expect(content.ok).toBe(false);
    expect(content.error).toContain("Unknown tool: teleport");
  });

  it("returns error for invalid JSON in tool arguments", async () => {
    const router = makeRouter([
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_bad",
            type: "function",
            function: { name: "click", arguments: "not-json{{" },
          }],
        },
        providerUsed: "groq",
      },
      {
        message: { role: "assistant", content: "Args were bad." },
        providerUsed: "groq",
      },
    ]);

    const messages = baseMessages();
    await runAgentLoop({ messages, tools: [], tabId: 1, router, onStatus: () => {} });

    const toolMsg = messages.find(m => m.role === "tool");
    const content = JSON.parse((toolMsg as { content: string }).content);
    expect(content.ok).toBe(false);
    expect(content.error).toContain("Invalid JSON");
  });
});

describe("runAgentLoop — CDP escalation", () => {
  beforeEach(clearMocks);

  it("escalates click to CDP when content script returns escalate:'cdp' and coords resolve", async () => {
    // First sendMessage: click returns escalate:cdp
    // Second sendMessage: getElementCoords returns coords
    tabsSendMessage
      .mockResolvedValueOnce({ ok: false, escalate: "cdp" })
      .mockResolvedValueOnce({ ok: true, x: 100, y: 200 });

    const router = makeRouter([
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_click",
            type: "function",
            function: { name: "click", arguments: '{"selector":"#btn"}' },
          }],
        },
        providerUsed: "groq",
      },
      {
        message: { role: "assistant", content: "Clicked via CDP." },
        providerUsed: "groq",
      },
    ]);

    const messages = baseMessages();
    await runAgentLoop({ messages, tools: [], tabId: 5, router, onStatus: () => {} });

    expect(mockDispatchClick).toHaveBeenCalledOnce();
    expect(mockDispatchClick).toHaveBeenCalledWith(5, 100, 200);

    const toolMsg = messages.find(m => m.role === "tool");
    const content = JSON.parse((toolMsg as { content: string }).content);
    expect(content.ok).toBe(true);
    expect(content.result).toContain("cdp-click");
  });

  it("returns error when CDP click escalation cannot resolve coordinates", async () => {
    tabsSendMessage
      .mockResolvedValueOnce({ ok: false, escalate: "cdp" })
      .mockResolvedValueOnce({ ok: false, error: "element not found" });

    const router = makeRouter([
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_click2",
            type: "function",
            function: { name: "click", arguments: '{"selector":"#ghost"}' },
          }],
        },
        providerUsed: "groq",
      },
      {
        message: { role: "assistant", content: "Could not click." },
        providerUsed: "groq",
      },
    ]);

    const messages = baseMessages();
    await runAgentLoop({ messages, tools: [], tabId: 5, router, onStatus: () => {} });

    const toolMsg = messages.find(m => m.role === "tool");
    const content = JSON.parse((toolMsg as { content: string }).content);
    expect(content.ok).toBe(false);
    expect(content.error).toContain("CDP escalation");
    expect(content.error).toContain("#ghost");
  });

  it("escalates type to CDP typeText when content script returns escalate:'cdp'", async () => {
    tabsSendMessage.mockResolvedValueOnce({ ok: false, escalate: "cdp" });

    const router = makeRouter([
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_type",
            type: "function",
            function: { name: "type", arguments: '{"selector":"input","text":"hello"}' },
          }],
        },
        providerUsed: "groq",
      },
      {
        message: { role: "assistant", content: "Typed via CDP." },
        providerUsed: "groq",
      },
    ]);

    const messages = baseMessages();
    await runAgentLoop({ messages, tools: [], tabId: 5, router, onStatus: () => {} });

    expect(mockTypeText).toHaveBeenCalledOnce();
    expect(mockTypeText).toHaveBeenCalledWith(5, "hello");

    const toolMsg = messages.find(m => m.role === "tool");
    const content = JSON.parse((toolMsg as { content: string }).content);
    expect(content.ok).toBe(true);
    expect(content.result).toContain("cdp-type");
  });
});

describe("runAgentLoop — error handling", () => {
  beforeEach(clearMocks);

  it("catches LLM error, returns synthetic error message, terminates loop", async () => {
    const router = makeErrorRouter(new Error("Network timeout"));
    const messages = baseMessages();
    const statuses: unknown[] = [];

    const result = await runAgentLoop({
      messages,
      tools: [],
      tabId: 1,
      router,
      onStatus: s => statuses.push(s),
    });

    expect(result.role).toBe("assistant");
    expect(result.content).toContain("Network timeout");
    // Status emitted with "LLM error:"
    expect((statuses[0] as { action: string }).action).toContain("LLM error:");
    // Synthetic error message appended to messages
    const lastMsg = messages[messages.length - 1]!;
    expect(lastMsg.role).toBe("assistant");
    expect((lastMsg as { content: string }).content).toContain("error");
  });

  it("handles sendMessage throwing — graceful error, loop continues", async () => {
    tabsSendMessage.mockRejectedValueOnce(new Error("Extension context invalidated"));

    const router = makeRouter([
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_err",
            type: "function",
            function: { name: "readPage", arguments: "{}" },
          }],
        },
        providerUsed: "groq",
      },
      {
        message: { role: "assistant", content: "Couldn't read page." },
        providerUsed: "groq",
      },
    ]);

    const messages = baseMessages();
    const result = await runAgentLoop({ messages, tools: [], tabId: 1, router, onStatus: () => {} });

    // Should still get a final answer (loop continued)
    expect(result.content).toBe("Couldn't read page.");

    const toolMsg = messages.find(m => m.role === "tool");
    const content = JSON.parse((toolMsg as { content: string }).content);
    expect(content.ok).toBe(false);
    expect(content.error).toContain("Extension context invalidated");
  });
});

describe("runAgentLoop — iteration cap", () => {
  beforeEach(clearMocks);

  it("terminates after 20 iterations with synthetic cap-reached message", async () => {
    // Always return tool_calls so loop never self-terminates
    tabsSendMessage.mockResolvedValue({ ok: true, result: "ok" });

    const alwaysToolCall = {
      message: {
        role: "assistant" as const,
        content: null,
        tool_calls: [{
          id: "call_inf",
          type: "function" as const,
          function: { name: "getUrl", arguments: "{}" },
        }],
      },
      providerUsed: "groq",
    };

    const router: Router = {
      chatCompletion: vi.fn().mockResolvedValue(alwaysToolCall),
    };

    const messages = baseMessages();
    const statuses: unknown[] = [];

    const result = await runAgentLoop({
      messages,
      tools: [],
      tabId: 1,
      router,
      onStatus: s => statuses.push(s),
    });

    // Should have iterated 20 times
    expect((router.chatCompletion as ReturnType<typeof vi.fn>).mock.calls.length).toBe(20);

    // Result is the synthetic cap-reached message
    expect(result.content).toContain("maximum number of steps");

    // Last status should reference iteration cap
    const lastStatus = statuses[statuses.length - 1] as { action: string; iter: number };
    expect(lastStatus.action).toContain("iteration cap");
    expect(lastStatus.iter).toBe(20);
  });
});

describe("runAgentLoop — onStatus callbacks", () => {
  beforeEach(clearMocks);

  it("fires status with correct iter, action, and providerUsed", async () => {
    tabsSendMessage.mockResolvedValueOnce({ ok: true, url: "https://example.com" });

    const router = makeRouter([
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_url",
            type: "function",
            function: { name: "getUrl", arguments: "{}" },
          }],
        },
        providerUsed: "cerebras",
      },
      {
        message: { role: "assistant", content: "Done." },
        providerUsed: "cerebras",
      },
    ]);

    const messages = baseMessages();
    const statuses: Array<{ iter: number; action: string; providerUsed?: string }> = [];

    await runAgentLoop({
      messages,
      tools: [],
      tabId: 1,
      router,
      onStatus: s => statuses.push(s),
    });

    expect(statuses).toHaveLength(2);
    // First status: tool dispatch
    expect(statuses[0]!.iter).toBe(1);
    expect(statuses[0]!.action).toContain("getUrl");
    expect(statuses[0]!.providerUsed).toBe("cerebras");
    // Second status: final answer
    expect(statuses[1]!.iter).toBe(2);
    expect(statuses[1]!.action).toBe("final answer");
  });
});
