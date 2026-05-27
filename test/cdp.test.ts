/**
 * test/cdp.test.ts
 *
 * Unit tests for src/background/cdp.ts.
 * Mocks chrome.debugger so tests run in Node without a real browser.
 *
 * Tests cover:
 *   1. attach() calls chrome.debugger.attach and marks the tab as attached
 *   2. attach() is idempotent — skips if already attached
 *   3. detach() calls chrome.debugger.detach and removes the tab from the set
 *   4. detach() is safe to call when tab is not attached (no-op)
 *   5. dispatchClick() attaches and sends mousePressed then mouseReleased
 *   6. dispatchKey() sends keyDown and keyUp; sets text for printable chars
 *   7. dispatchKey() does NOT set text for non-printable multi-char keys (e.g. "Enter")
 *   8. onDetach listener removes the tab from the attached set
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// chrome.debugger mock — set up before importing cdp.ts
// ---------------------------------------------------------------------------

const debuggerAttach = vi.fn().mockResolvedValue(undefined);
const debuggerDetach = vi.fn().mockResolvedValue(undefined);
const debuggerSendCommand = vi.fn().mockResolvedValue({});

// Collect onDetach listeners so we can trigger them in tests
const onDetachListeners: Array<(source: { tabId?: number }) => void> = [];
const onDetach = {
  addListener: vi.fn((cb: (source: { tabId?: number }) => void) => {
    onDetachListeners.push(cb);
  }),
};

(globalThis as Record<string, unknown>).chrome = {
  debugger: {
    attach: debuggerAttach,
    detach: debuggerDetach,
    sendCommand: debuggerSendCommand,
    onDetach,
  },
};

// ---------------------------------------------------------------------------
// Import cdp after mocks are installed
// ---------------------------------------------------------------------------

// cdp.ts registers its onDetach listener at import time — the mock must be
// in place before the import runs.
const { attach, detach, dispatchClick, dispatchKey } = await import(
  "../src/background/cdp.js"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clearMocks() {
  debuggerAttach.mockClear();
  debuggerDetach.mockClear();
  debuggerSendCommand.mockClear();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cdp.attach", () => {
  beforeEach(clearMocks);

  it("calls chrome.debugger.attach with the tab id and protocol version '1.3'", async () => {
    await attach(101);
    expect(debuggerAttach).toHaveBeenCalledOnce();
    expect(debuggerAttach).toHaveBeenCalledWith({ tabId: 101 }, "1.3");
  });

  it("is idempotent — does not call attach again if already attached", async () => {
    await attach(102);
    await attach(102); // second call — should be a no-op
    expect(debuggerAttach).toHaveBeenCalledOnce();
  });

  it("can attach different tabs independently", async () => {
    await attach(201);
    await attach(202);
    expect(debuggerAttach).toHaveBeenCalledTimes(2);
    expect(debuggerAttach).toHaveBeenNthCalledWith(1, { tabId: 201 }, "1.3");
    expect(debuggerAttach).toHaveBeenNthCalledWith(2, { tabId: 202 }, "1.3");
  });
});

describe("cdp.detach", () => {
  beforeEach(clearMocks);

  it("calls chrome.debugger.detach and removes the tab from tracking", async () => {
    await attach(301);
    clearMocks();

    await detach(301);
    expect(debuggerDetach).toHaveBeenCalledOnce();
    expect(debuggerDetach).toHaveBeenCalledWith({ tabId: 301 });
  });

  it("is safe to call when tab is not attached — no chrome.debugger call made", async () => {
    await detach(999); // never attached
    expect(debuggerDetach).not.toHaveBeenCalled();
  });

  it("allows re-attach after detach", async () => {
    await attach(401);
    clearMocks();

    await detach(401);
    clearMocks();

    // Re-attach should call chrome.debugger.attach again
    await attach(401);
    expect(debuggerAttach).toHaveBeenCalledOnce();
  });
});

describe("cdp.dispatchClick", () => {
  beforeEach(clearMocks);

  it("attaches debugger and sends mousePressed then mouseReleased at (x,y)", async () => {
    await attach(501);
    clearMocks();

    await dispatchClick(501, 100, 200);

    // Should NOT call attach again (already attached) and sendCommand twice
    expect(debuggerAttach).not.toHaveBeenCalled();
    expect(debuggerSendCommand).toHaveBeenCalledTimes(2);

    const [firstTarget, firstMethod, firstParams] = debuggerSendCommand.mock.calls[0]!;
    const [, secondMethod, secondParams] = debuggerSendCommand.mock.calls[1]!;

    expect(firstTarget).toEqual({ tabId: 501 });
    expect(firstMethod).toBe("Input.dispatchMouseEvent");
    expect((firstParams as Record<string, unknown>).type).toBe("mousePressed");
    expect((firstParams as Record<string, unknown>).x).toBe(100);
    expect((firstParams as Record<string, unknown>).y).toBe(200);
    expect((firstParams as Record<string, unknown>).button).toBe("left");

    expect(secondMethod).toBe("Input.dispatchMouseEvent");
    expect((secondParams as Record<string, unknown>).type).toBe("mouseReleased");
    expect((secondParams as Record<string, unknown>).x).toBe(100);
    expect((secondParams as Record<string, unknown>).y).toBe(200);
  });

  it("auto-attaches if the tab is not yet attached", async () => {
    // Tab 600 was never attached
    await dispatchClick(600, 50, 50);

    expect(debuggerAttach).toHaveBeenCalledOnce();
    expect(debuggerAttach).toHaveBeenCalledWith({ tabId: 600 }, "1.3");
    expect(debuggerSendCommand).toHaveBeenCalledTimes(2);
  });
});

describe("cdp.dispatchKey", () => {
  beforeEach(clearMocks);

  it("sends keyDown and keyUp for a printable character with text set", async () => {
    await attach(701);
    clearMocks();

    await dispatchKey(701, "a");

    expect(debuggerSendCommand).toHaveBeenCalledTimes(2);

    const [, downMethod, downParams] = debuggerSendCommand.mock.calls[0]!;
    const [, upMethod, upParams] = debuggerSendCommand.mock.calls[1]!;

    expect(downMethod).toBe("Input.dispatchKeyEvent");
    expect((downParams as Record<string, unknown>).type).toBe("keyDown");
    expect((downParams as Record<string, unknown>).key).toBe("a");
    // Single printable char: text should be set
    expect((downParams as Record<string, unknown>).text).toBe("a");

    expect(upMethod).toBe("Input.dispatchKeyEvent");
    expect((upParams as Record<string, unknown>).type).toBe("keyUp");
    expect((upParams as Record<string, unknown>).key).toBe("a");
  });

  it("sends keyDown and keyUp for 'Enter' WITHOUT setting text", async () => {
    await attach(702);
    clearMocks();

    await dispatchKey(702, "Enter");

    const [, , downParams] = debuggerSendCommand.mock.calls[0]!;
    const [, , upParams] = debuggerSendCommand.mock.calls[1]!;

    expect((downParams as Record<string, unknown>).key).toBe("Enter");
    // Multi-char key: text should NOT be set
    expect((downParams as Record<string, unknown>).text).toBeUndefined();
    expect((upParams as Record<string, unknown>).key).toBe("Enter");
  });
});

describe("cdp — onDetach listener", () => {
  beforeEach(clearMocks);

  it("removes a tab from the attached set when onDetach fires", async () => {
    await attach(801);
    clearMocks();

    // Trigger the onDetach listener as if Chrome fired it
    for (const listener of onDetachListeners) {
      listener({ tabId: 801 });
    }

    // Now detach should be a no-op (tab removed from set)
    await detach(801);
    expect(debuggerDetach).not.toHaveBeenCalled();
  });

  it("handles onDetach with undefined tabId without throwing", () => {
    expect(() => {
      for (const listener of onDetachListeners) {
        listener({}); // tabId is undefined
      }
    }).not.toThrow();
  });
});
