/**
 * test/auto-provision.test.ts
 *
 * Unit tests for src/onboarding/auto-provision.ts
 *
 * All Chrome extension APIs and cdp/keys modules are mocked.
 * Tests cover:
 *   1. Success path: flow runs, key extracted, saveKey called -> {ok:true, keyId}
 *   2. Failure path: selector not found -> {ok:false, error}, cleanup still runs
 *   3. Unsupported provider -> {ok:false, error} (no tab created)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock cdp module
// ---------------------------------------------------------------------------

vi.mock("../src/background/cdp.js", () => ({
  attach: vi.fn().mockResolvedValue(undefined),
  detach: vi.fn().mockResolvedValue(undefined),
  dispatchClick: vi.fn().mockResolvedValue(undefined),
  typeText: vi.fn().mockResolvedValue(undefined),
  dispatchKey: vi.fn().mockResolvedValue(undefined),
  screenshot: vi.fn().mockResolvedValue("data:image/png;base64,"),
}));

// ---------------------------------------------------------------------------
// Mock keys module
// ---------------------------------------------------------------------------

vi.mock("../src/storage/keys.js", () => ({
  saveKey: vi.fn().mockResolvedValue("k_auto_test_001"),
}));

// ---------------------------------------------------------------------------
// Chrome API mocks
// ---------------------------------------------------------------------------

const mockTabId = 42;
let tabsCreateResult = { id: mockTabId, status: "complete", url: "https://aistudio.google.com/apikey" };
let tabsGetResult = { id: mockTabId, status: "complete", url: "https://aistudio.google.com/apikey" };
// sendMessage returns different things depending on the op
let sendMessageImpl: (msg: unknown) => unknown = () => ({ ok: true, found: true, text: "AIzaSy_fake_key_123456" });

(globalThis as Record<string, unknown>).chrome = {
  tabs: {
    create: vi.fn().mockImplementation(async () => tabsCreateResult),
    get: vi.fn().mockImplementation(async () => tabsGetResult),
    remove: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockImplementation(async (_id: number, msg: unknown) => sendMessageImpl(msg)),
  },
  debugger: {
    sendCommand: vi.fn().mockResolvedValue({ result: { value: "AIzaSy_fake_key_123456" } }),
  },
};

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import { autoProvision } from "../src/onboarding/auto-provision.js";
import * as cdp from "../src/background/cdp.js";
import { saveKey } from "../src/storage/keys.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetMocks() {
  // Clear all call counts from previous test
  vi.mocked(chrome.tabs.create).mockClear();
  vi.mocked(chrome.tabs.get).mockClear();
  vi.mocked(chrome.tabs.remove).mockClear();
  vi.mocked(chrome.tabs.sendMessage).mockClear();
  vi.mocked(chrome.debugger.sendCommand).mockClear();
  vi.mocked(cdp.attach).mockClear();
  vi.mocked(cdp.detach).mockClear();
  vi.mocked(saveKey as ReturnType<typeof vi.fn>).mockClear();

  tabsCreateResult = { id: mockTabId, status: "complete", url: "https://aistudio.google.com/apikey" };
  tabsGetResult = { id: mockTabId, status: "complete", url: "https://aistudio.google.com/apikey" };
  // Default sendMessage: waitForSelector ok, readText returns the key, click ok
  sendMessageImpl = (msg: unknown) => {
    const m = msg as { kind: string; payload: { op: string; text?: string } };
    if (m?.payload?.op === "waitForSelector") return { ok: true, found: true };
    if (m?.payload?.op === "readText") return { ok: true, text: "AIzaSy_fake_key_123456" };
    if (m?.payload?.op === "click") return { ok: true };
    if (m?.payload?.op === "getElementCoords") return { ok: false };
    return { ok: false, error: "unknown op" };
  };
  vi.mocked(chrome.tabs.create).mockResolvedValue(tabsCreateResult as unknown as void);
  vi.mocked(chrome.tabs.get).mockResolvedValue(tabsGetResult as unknown as chrome.tabs.Tab);
  vi.mocked(chrome.tabs.remove).mockResolvedValue(undefined);
  vi.mocked(chrome.tabs.sendMessage).mockImplementation(
    async (_id: number, msg: unknown) => sendMessageImpl(msg),
  );
  vi.mocked(chrome.debugger.sendCommand).mockResolvedValue({ result: { value: "AIzaSy_fake_key_123456" } } as unknown as void);
  vi.mocked(cdp.attach).mockResolvedValue(undefined);
  vi.mocked(cdp.detach).mockResolvedValue(undefined);
  vi.mocked(saveKey as ReturnType<typeof vi.fn>).mockResolvedValue("k_auto_test_001");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("autoProvision", () => {
  beforeEach(() => {
    // Make setTimeout resolve immediately so sleep() calls don't block tests
    vi.spyOn(globalThis, "setTimeout").mockImplementation((fn: TimerHandler) => {
      if (typeof fn === "function") fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });
    resetMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Test 1: Success path for google
  it("returns {ok:true, keyId} when all automation steps succeed (google)", async () => {
    const result = await autoProvision("google");

    expect(result.ok).toBe(true);
    expect(result.keyId).toBe("k_auto_test_001");
    expect(result.error).toBeUndefined();

    // CDP was attached and detached
    expect(cdp.attach).toHaveBeenCalledWith(mockTabId);
    expect(cdp.detach).toHaveBeenCalledWith(mockTabId);
    // Tab was created and removed (cleanup in finally)
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: "https://aistudio.google.com/apikey",
      active: false,
    });
    expect(chrome.tabs.remove).toHaveBeenCalledWith(mockTabId);
    // saveKey was called with correct provider and label
    expect(saveKey).toHaveBeenCalledWith("google", "AIzaSy_fake_key_123456", "auto");
  });

  // Test 2: Failure path — selector not found, cleanup still runs
  it("returns {ok:false, error} when Create button not found, and cleanup always runs", async () => {
    // All waitForSelector calls return not-found
    sendMessageImpl = (msg: unknown) => {
      const m = msg as { kind: string; payload: { op: string } };
      if (m?.payload?.op === "waitForSelector") return { ok: false, found: false, error: "timeout" };
      if (m?.payload?.op === "click") return { ok: false, error: "not found" };
      return { ok: false, error: "unknown op" };
    };
    vi.mocked(chrome.tabs.sendMessage).mockImplementation(
      async (_id: number, msg: unknown) => sendMessageImpl(msg),
    );

    const result = await autoProvision("groq");

    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");
    expect(result.error).toMatch(/Could not find/i);

    // Cleanup MUST still run even on failure
    expect(cdp.detach).toHaveBeenCalledWith(mockTabId);
    expect(chrome.tabs.remove).toHaveBeenCalledWith(mockTabId);
    // saveKey must NOT have been called
    expect(saveKey).not.toHaveBeenCalled();
  });

  // Test 3: Unsupported provider
  it("returns {ok:false, error} immediately for unsupported provider without creating a tab", async () => {
    const result = await autoProvision("openai");

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unsupported provider/i);
    expect(result.error).toContain("openai");
    // No tab should have been created
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    // No CDP attach
    expect(cdp.attach).not.toHaveBeenCalled();
  });

  // Test 4: Login wall detected
  it("returns {ok:false, error} when redirected to login page", async () => {
    tabsGetResult = {
      id: mockTabId,
      status: "complete",
      url: "https://accounts.google.com/signin",
    };
    vi.mocked(chrome.tabs.get).mockResolvedValue(tabsGetResult as unknown as chrome.tabs.Tab);

    const result = await autoProvision("google");

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Login required/i);
    // Cleanup still runs
    expect(cdp.detach).toHaveBeenCalledWith(mockTabId);
    expect(chrome.tabs.remove).toHaveBeenCalledWith(mockTabId);
  });
});
