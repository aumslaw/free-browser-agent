/**
 * test/content-dispatch.test.ts
 *
 * Unit tests for src/content/index.ts -- the chrome.runtime.onMessage listener
 * and the op dispatcher (dispatch()).
 *
 * Strategy:
 *   - Mock all dom-ops functions via vi.mock() + vi.hoisted() so no DOM is needed.
 *   - Mock chrome.runtime.onMessage.addListener to capture the registered callback.
 *   - Invoke the captured callback directly with various message shapes.
 *
 * Tests cover:
 *   1.  "dom-digest" message -> calls domDigest(), responds {ok:true, result:...}
 *   2.  "dom-digest" when domDigest throws -> responds {ok:false, error:...}
 *   3.  "dom-digest" listener returns false (synchronous -- close channel)
 *   4.  Unknown message kind -> responds {ok:false, error:"Unknown message kind:..."}
 *   5.  Unknown message kind listener returns false (close channel)
 *   6.  "dom-op" click -> routes to click(), responds ok
 *   7.  "dom-op" type -> routes to type() with selector + text
 *   8.  "dom-op" fillForm -> routes to fillForm() with form spec
 *   9.  "dom-op" scroll -> routes to scroll()
 *  10.  "dom-op" getUrl -> routes to getUrl()
 *  11.  "dom-op" getSelection -> routes to getSelection()
 *  12.  "dom-op" domDigest (inline op) -> routes to domDigest()
 *  13.  "dom-op" readPage -> routes to readPage()
 *  14.  "dom-op" waitForSelector -- async, returns true (keep channel open)
 *  15.  "dom-op" waitForSelector -- uses default 5000ms when no timeout arg
 *  16.  "dom-op" sync op returns false (close channel)
 *  17.  "dom-op" dispatch throws synchronously -> responds {ok:false, error:...}
 *  18.  "dom-op" click returning a Promise -> returns true (keep channel open)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoist mock factories before vi.mock() is hoisted by Vitest
// ---------------------------------------------------------------------------

const {
  mockClick,
  mockType,
  mockFillForm,
  mockScroll,
  mockWaitForSelector,
  mockGetUrl,
  mockGetSelection,
  mockDomDigest,
  mockReadPage,
} = vi.hoisted(() => ({
  mockClick: vi.fn(),
  mockType: vi.fn(),
  mockFillForm: vi.fn(),
  mockScroll: vi.fn(),
  mockWaitForSelector: vi.fn(),
  mockGetUrl: vi.fn(),
  mockGetSelection: vi.fn(),
  mockDomDigest: vi.fn(),
  mockReadPage: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock dom-ops -- no real DOM environment needed in this test file
// ---------------------------------------------------------------------------

vi.mock("../src/content/dom-ops.js", () => ({
  click: mockClick,
  type: mockType,
  fillForm: mockFillForm,
  scroll: mockScroll,
  waitForSelector: mockWaitForSelector,
  getUrl: mockGetUrl,
  getSelection: mockGetSelection,
  domDigest: mockDomDigest,
  readPage: mockReadPage,
}));

// ---------------------------------------------------------------------------
// Capture chrome.runtime.onMessage listener BEFORE the content script runs.
// The content script registers its listener at module-eval time.
// ---------------------------------------------------------------------------

type Listener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void
) => boolean | void;

let capturedListener: Listener | null = null;

(globalThis as Record<string, unknown>).chrome = {
  runtime: {
    onMessage: {
      addListener: vi.fn().mockImplementation((fn: Listener) => {
        capturedListener = fn;
      }),
    },
  },
};

// Importing the content script triggers addListener, capturing the listener
await import("../src/content/index.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fakeSender: chrome.runtime.MessageSender = { id: "ext-id" };

/** Call listener synchronously; capture return value + sendResponse arg. */
function callListenerSync(message: unknown): {
  returnValue: boolean | void;
  response: unknown;
} {
  let captured: unknown = undefined;
  const returnValue = capturedListener!(message, fakeSender, (r) => {
    captured = r;
  });
  return { returnValue, response: captured };
}

/** Call listener and wait for async sendResponse (Promise-based ops). */
async function callListenerAsync(message: unknown): Promise<{
  returnValue: boolean | void;
  response: unknown;
}> {
  return new Promise((resolve) => {
    let returnVal: boolean | void;
    returnVal = capturedListener!(message, fakeSender, (r) => {
      resolve({ returnValue: returnVal, response: r });
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("content-script message handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -- dom-digest shorthand -------------------------------------------------

  it("dom-digest: calls domDigest() and responds {ok:true, result:...}", () => {
    mockDomDigest.mockReturnValue({ url: "https://example.com", title: "Test" });
    const { response } = callListenerSync({ kind: "dom-digest" });
    expect(mockDomDigest).toHaveBeenCalledOnce();
    expect((response as Record<string, unknown>).ok).toBe(true);
    expect((response as Record<string, unknown>).result).toEqual({
      url: "https://example.com",
      title: "Test",
    });
  });

  it("dom-digest: responds {ok:false, error:...} when domDigest throws", () => {
    mockDomDigest.mockImplementation(() => { throw new Error("DOM unavailable"); });
    const { response } = callListenerSync({ kind: "dom-digest" });
    expect((response as Record<string, unknown>).ok).toBe(false);
    expect(String((response as Record<string, unknown>).error)).toContain("DOM unavailable");
  });

  it("dom-digest: listener returns false (synchronous -- close channel)", () => {
    mockDomDigest.mockReturnValue({});
    const { returnValue } = callListenerSync({ kind: "dom-digest" });
    expect(returnValue).toBe(false);
  });

  // -- unknown message kind -------------------------------------------------

  it("unknown kind: responds with ok:false and error containing kind name", () => {
    const { response } = callListenerSync({ kind: "magic-wand" });
    expect((response as Record<string, unknown>).ok).toBe(false);
    expect(String((response as Record<string, unknown>).error)).toContain("magic-wand");
  });

  it("unknown kind: listener returns false (close channel)", () => {
    const { returnValue } = callListenerSync({ kind: "mystery" });
    expect(returnValue).toBe(false);
  });

  // -- dom-op routing -------------------------------------------------------

  it("dom-op click: routes to click() and responds ok:true", () => {
    mockClick.mockReturnValue({ ok: true });
    const { response } = callListenerSync({
      kind: "dom-op",
      op: "click",
      args: [{ role: "button", name: "Submit" }],
    });
    expect(mockClick).toHaveBeenCalledWith({ role: "button", name: "Submit" });
    expect((response as Record<string, unknown>).ok).toBe(true);
  });

  it("dom-op type: routes to type() with selector and text", () => {
    mockType.mockReturnValue({ ok: true });
    const { response } = callListenerSync({
      kind: "dom-op",
      op: "type",
      args: ["#input", "hello"],
    });
    expect(mockType).toHaveBeenCalledWith("#input", "hello");
    expect((response as Record<string, unknown>).ok).toBe(true);
  });

  it("dom-op fillForm: routes to fillForm() with form spec", () => {
    mockFillForm.mockReturnValue({ ok: true, filled: ["#q"], errors: {} });
    const { response } = callListenerSync({
      kind: "dom-op",
      op: "fillForm",
      args: [{ "#q": "vitest" }],
    });
    expect(mockFillForm).toHaveBeenCalledWith({ "#q": "vitest" });
    expect((response as Record<string, unknown>).ok).toBe(true);
  });

  it("dom-op scroll: routes to scroll() with target", () => {
    mockScroll.mockReturnValue({ ok: true });
    const { response } = callListenerSync({
      kind: "dom-op",
      op: "scroll",
      args: [{ x: 0, y: 500 }],
    });
    expect(mockScroll).toHaveBeenCalledWith({ x: 0, y: 500 });
    expect((response as Record<string, unknown>).ok).toBe(true);
  });

  it("dom-op getUrl: routes to getUrl()", () => {
    mockGetUrl.mockReturnValue({ ok: true, url: "https://example.com" });
    const { response } = callListenerSync({ kind: "dom-op", op: "getUrl", args: [] });
    expect(mockGetUrl).toHaveBeenCalledOnce();
    expect((response as Record<string, unknown>).ok).toBe(true);
  });

  it("dom-op getSelection: routes to getSelection()", () => {
    mockGetSelection.mockReturnValue({ ok: true, text: "selected" });
    const { response } = callListenerSync({ kind: "dom-op", op: "getSelection", args: [] });
    expect(mockGetSelection).toHaveBeenCalledOnce();
    expect((response as Record<string, unknown>).ok).toBe(true);
  });

  it("dom-op domDigest (inline op): routes to domDigest()", () => {
    mockDomDigest.mockReturnValue({ url: "https://test.com", title: "Inline" });
    const { response } = callListenerSync({ kind: "dom-op", op: "domDigest", args: [] });
    expect(mockDomDigest).toHaveBeenCalledOnce();
    expect((response as Record<string, unknown>).ok).toBe(true);
  });

  it("dom-op readPage: routes to readPage()", () => {
    mockReadPage.mockReturnValue({ ok: true, markdown: "# Hello" });
    const { response } = callListenerSync({ kind: "dom-op", op: "readPage", args: [] });
    expect(mockReadPage).toHaveBeenCalledOnce();
    expect((response as Record<string, unknown>).ok).toBe(true);
  });

  // -- async ops (waitForSelector) ------------------------------------------

  it("dom-op waitForSelector: returns true (keep channel) and resolves async response", async () => {
    mockWaitForSelector.mockResolvedValue({ ok: true, found: true });
    const { returnValue, response } = await callListenerAsync({
      kind: "dom-op",
      op: "waitForSelector",
      args: ["#late-el", 3000],
    });
    expect(returnValue).toBe(true);
    expect((response as Record<string, unknown>).ok).toBe(true);
    expect((response as Record<string, unknown>).result).toEqual({ ok: true, found: true });
    expect(mockWaitForSelector).toHaveBeenCalledWith("#late-el", 3000);
  });

  it("dom-op waitForSelector: uses default 5000ms when no timeout arg provided", async () => {
    mockWaitForSelector.mockResolvedValue({ ok: true, found: false });
    await callListenerAsync({ kind: "dom-op", op: "waitForSelector", args: ["#elem"] });
    // dispatch() fills in 5000: waitForSelector(selector, timeoutMs ?? 5000)
    expect(mockWaitForSelector).toHaveBeenCalledWith("#elem", 5000);
  });

  // -- sync ops return false -------------------------------------------------

  it("dom-op sync op (click): listener returns false (close channel)", () => {
    mockClick.mockReturnValue({ ok: true });
    const { returnValue } = callListenerSync({ kind: "dom-op", op: "click", args: ["#btn"] });
    expect(returnValue).toBe(false);
  });

  // -- dispatch throws synchronously ----------------------------------------

  it("dom-op: dispatch throws -> responds {ok:false, error:...}", () => {
    mockClick.mockImplementation(() => { throw new TypeError("element.click is not a function"); });
    const { response } = callListenerSync({ kind: "dom-op", op: "click", args: ["#broken"] });
    expect((response as Record<string, unknown>).ok).toBe(false);
    expect(String((response as Record<string, unknown>).error)).toContain(
      "element.click is not a function"
    );
  });

  // -- Promise-returning op keeps channel open ------------------------------

  it("dom-op click returning a Promise: listener returns true (keep channel open)", async () => {
    mockClick.mockReturnValue(
      Promise.resolve({ ok: false, escalate: "cdp", error: "cross-origin" })
    );
    const { returnValue, response } = await callListenerAsync({
      kind: "dom-op",
      op: "click",
      args: ["#cdp-target"],
    });
    expect(returnValue).toBe(true);
    expect((response as Record<string, unknown>).result).toMatchObject({
      ok: false,
      escalate: "cdp",
    });
  });
});
