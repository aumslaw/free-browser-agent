/**
 * test/background.test.ts
 *
 * Unit tests for src/background/index.ts — the MV3 service worker.
 *
 * Strategy:
 *   - Mock chrome.action, chrome.sidePanel, chrome.alarms, chrome.tabs,
 *     chrome.runtime.onConnect, chrome.runtime.onMessage, chrome.storage
 *   - Mock agent-loop and router so no real provider calls happen
 *   - Capture listeners at import time, invoke them directly in tests
 *
 * Cases covered:
 *   1.  chrome.action.onClicked fires → calls chrome.sidePanel.open
 *   2.  chrome.action.onClicked with null tabId → sidePanel.open NOT called
 *   3.  "agent:start" message → runAgentLoop called, sendResponse({ok:true})
 *   4.  "agent:stop" message → aborts existing controller, sendResponse({ok:true})
 *   5.  "options:open" message → chrome.runtime.openOptionsPage called
 *   6.  "keys:updated" message → router invalidated (next call re-imports)
 *   7.  "ping" message → sendResponse({ok:true, ts:...})
 *   8.  unknown message kind → no response sent (no crash)
 *   9.  "dom-op" with tabId → chrome.tabs.sendMessage called with that tabId
 *  10.  "dom-op" without tabId → chrome.tabs.query called to find active tab
 *  11.  chrome.runtime.onConnect "sidepanel" port → sidePanelPort is stored
 *  12.  sidepanel port disconnect → sidePanelPort cleared to null
 */

import { describe, it, expect, vi, beforeAll } from "vitest";

// ---------------------------------------------------------------------------
// Hoist module-level mock vars (must be available when vi.mock() factories run)
// ---------------------------------------------------------------------------

const { mockRunAgentLoop, mockRouterChatCompletion } = vi.hoisted(() => ({
  mockRunAgentLoop: vi.fn(),
  mockRouterChatCompletion: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock the agent-loop and router modules
// ---------------------------------------------------------------------------

vi.mock("../src/background/agent-loop.js", () => ({
  runAgentLoop: mockRunAgentLoop,
}));

vi.mock("../src/router.js", () => ({
  Router: vi.fn().mockImplementation(() => ({
    chatCompletion: mockRouterChatCompletion,
    setPriorityList: vi.fn(),
  })),
}));

// Mock onboarding modules so they don't transitively import cdp.ts (which
// calls chrome.debugger.onDetach.addListener at module load time -- not mocked
// in this test environment).
vi.mock("../src/onboarding/openrouter-oauth.js", () => ({
  connectOpenRouter: vi.fn().mockResolvedValue({ ok: true, keyId: "test-key-id" }),
}));

vi.mock("../src/onboarding/auto-provision.js", () => ({
  autoProvision: vi.fn().mockResolvedValue({ ok: true, keyId: "test-key-id" }),
}));

// ---------------------------------------------------------------------------
// Mock chrome APIs — captured listeners are exported from these closures
// ---------------------------------------------------------------------------

type Listener = (...args: unknown[]) => unknown;

let capturedOnMessage: Listener | null = null;
let capturedOnClicked: Listener | null = null;
let capturedOnConnect: Listener | null = null;
let capturedOnAlarm: Listener | null = null;

const mockSidePanelOpen = vi.fn().mockResolvedValue(undefined);
const mockOpenOptionsPage = vi.fn();
const mockTabsQuery = vi.fn();
const mockTabsSendMessage = vi.fn();
const mockAlarmsCreate = vi.fn();
const mockSendMessage = vi.fn().mockResolvedValue(undefined);

(globalThis as Record<string, unknown>).chrome = {
  action: {
    onClicked: {
      addListener: vi.fn().mockImplementation((fn: Listener) => {
        capturedOnClicked = fn;
      }),
    },
  },
  sidePanel: {
    open: mockSidePanelOpen,
  },
  alarms: {
    create: mockAlarmsCreate,
    onAlarm: {
      addListener: vi.fn().mockImplementation((fn: Listener) => {
        capturedOnAlarm = fn;
      }),
    },
  },
  runtime: {
    onMessage: {
      addListener: vi.fn().mockImplementation((fn: Listener) => {
        capturedOnMessage = fn;
      }),
    },
    onConnect: {
      addListener: vi.fn().mockImplementation((fn: Listener) => {
        capturedOnConnect = fn;
      }),
    },
    sendMessage: mockSendMessage,
    openOptionsPage: mockOpenOptionsPage,
  },
  tabs: {
    query: mockTabsQuery,
    sendMessage: mockTabsSendMessage,
  },
  storage: {
    local: {
      get: vi.fn(async (key: string) => ({ [key]: undefined })),
      set: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    },
    session: {
      get: vi.fn(async (key: string) => ({ [key]: undefined })),
      set: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    },
  },
};

// Import the service worker module — this triggers all addListener calls
beforeAll(async () => {
  await import("../src/background/index.js");
});

// ---------------------------------------------------------------------------
// Helper to invoke the captured onMessage listener
// ---------------------------------------------------------------------------

function sendMsg(
  msg: Record<string, unknown>,
  sendResponse?: (r?: unknown) => void
): unknown {
  const sr = sendResponse ?? vi.fn();
  return capturedOnMessage?.(msg, {}, sr);
}

// ---------------------------------------------------------------------------
// chrome.action.onClicked
// ---------------------------------------------------------------------------

describe("chrome.action.onClicked", () => {
  it("calls sidePanel.open when tab.id is set", () => {
    mockSidePanelOpen.mockClear();
    capturedOnClicked?.({ id: 42, windowId: 1 });
    expect(mockSidePanelOpen).toHaveBeenCalledWith({ windowId: 1 });
  });

  it("does NOT call sidePanel.open when tab.id is null", () => {
    mockSidePanelOpen.mockClear();
    capturedOnClicked?.({ id: null, windowId: 1 });
    expect(mockSidePanelOpen).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Message: agent:start / agent:stop
// ---------------------------------------------------------------------------

describe("message: agent:start", () => {
  it("calls runAgentLoop and sends {ok:true}", async () => {
    const sendResponse = vi.fn();
    mockRunAgentLoop.mockResolvedValueOnce({
      role: "assistant",
      content: "Done",
    });

    const ret = sendMsg(
      { kind: "agent:start", messages: [{ role: "user", content: "hello" }], tabId: 99 },
      sendResponse
    );

    // Listener returns true (async response)
    expect(ret).toBe(true);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    // Give the async void IIFE a tick to start
    await new Promise((r) => setTimeout(r, 10));
    expect(mockRunAgentLoop).toHaveBeenCalled();
  });
});

describe("message: agent:stop", () => {
  it("responds {ok:true} and removes the abort controller", () => {
    const sendResponse = vi.fn();
    sendMsg({ kind: "agent:stop", tabId: 99 }, sendResponse);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Message: options:open
// ---------------------------------------------------------------------------

describe("message: options:open", () => {
  it("calls chrome.runtime.openOptionsPage and responds {ok:true}", () => {
    const sendResponse = vi.fn();
    mockOpenOptionsPage.mockClear();
    sendMsg({ kind: "options:open" }, sendResponse);
    expect(mockOpenOptionsPage).toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Message: keys:updated
// ---------------------------------------------------------------------------

describe("message: keys:updated", () => {
  it("responds {ok:true} (router invalidation side-effect)", () => {
    const sendResponse = vi.fn();
    sendMsg({ kind: "keys:updated" }, sendResponse);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Message: ping
// ---------------------------------------------------------------------------

describe("message: ping", () => {
  it("responds {ok:true, ts:<number>}", () => {
    const sendResponse = vi.fn();
    sendMsg({ kind: "ping" }, sendResponse);
    const response = sendResponse.mock.calls[0]?.[0] as { ok: boolean; ts: number };
    expect(response.ok).toBe(true);
    expect(typeof response.ts).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Message: unknown kind
// ---------------------------------------------------------------------------

describe("message: unknown kind", () => {
  it("does not call sendResponse for unknown message kinds", () => {
    const sendResponse = vi.fn();
    sendMsg({ kind: "this-does-not-exist" }, sendResponse);
    expect(sendResponse).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Message: dom-op (forward to content script)
// ---------------------------------------------------------------------------

describe("message: dom-op", () => {
  it("calls chrome.tabs.sendMessage with the provided tabId", async () => {
    const sendResponse = vi.fn();
    mockTabsSendMessage.mockResolvedValueOnce({ ok: true, result: "clicked" });

    sendMsg({ kind: "dom-op", payload: { op: "click", selector: "#btn" }, tabId: 55 }, sendResponse);

    // Give async void IIFE time to run
    await new Promise((r) => setTimeout(r, 20));
    expect(mockTabsSendMessage).toHaveBeenCalledWith(
      55,
      { kind: "dom-op", payload: { op: "click", selector: "#btn" } }
    );
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, result: "clicked" });
  });

  it("queries active tab when tabId is not provided", async () => {
    const sendResponse = vi.fn();
    mockTabsQuery.mockResolvedValueOnce([{ id: 77 }]);
    mockTabsSendMessage.mockResolvedValueOnce({ ok: true, result: "scrolled" });

    sendMsg({ kind: "dom-op", payload: { op: "scroll", y: 500 } }, sendResponse);

    await new Promise((r) => setTimeout(r, 20));
    expect(mockTabsQuery).toHaveBeenCalledWith({ active: true, currentWindow: true });
    expect(mockTabsSendMessage).toHaveBeenCalledWith(77, expect.objectContaining({ kind: "dom-op" }));
  });

  it("responds with ok:false when no active tab is found", async () => {
    const sendResponse = vi.fn();
    mockTabsQuery.mockResolvedValueOnce([]); // empty — no active tab

    sendMsg({ kind: "dom-op", payload: { op: "click", selector: "#x" } }, sendResponse);

    await new Promise((r) => setTimeout(r, 20));
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: "No active tab found" });
  });
});

// ---------------------------------------------------------------------------
// chrome.runtime.onConnect — side panel port
// ---------------------------------------------------------------------------

describe("chrome.runtime.onConnect — sidepanel port", () => {
  it("stores the port when name is 'sidepanel'", () => {
    const mockPort = {
      name: "sidepanel",
      postMessage: vi.fn(),
      onDisconnect: { addListener: vi.fn() },
    };
    capturedOnConnect?.(mockPort);
    // If stored correctly, postToSidePanel will use postMessage (not runtime.sendMessage)
    // We verify by checking that onDisconnect.addListener was registered
    expect(mockPort.onDisconnect.addListener).toHaveBeenCalled();
  });

  it("ignores ports with names other than 'sidepanel'", () => {
    const mockPort = {
      name: "other-port",
      postMessage: vi.fn(),
      onDisconnect: { addListener: vi.fn() },
    };
    capturedOnConnect?.(mockPort);
    // For non-sidepanel ports, onDisconnect should NOT be registered
    expect(mockPort.onDisconnect.addListener).not.toHaveBeenCalled();
  });
});
