/**
 * test/speech.test.ts
 *
 * Unit tests for src/sidepanel/lib/speech.ts — useSpeechRecognition hook.
 *
 * Strategy: mock preact/hooks to provide a controlled synchronous state
 * implementation, then call useSpeechRecognition() as a plain function.
 * This avoids requiring @testing-library/preact (not installed).
 *
 * The mocked useState/useRef/useEffect give us a synchronous "mini-renderer"
 * that lets us inspect and mutate hook state directly.
 *
 * Cases:
 *   1. supported=true when webkitSpeechRecognition is on window
 *   2. supported=false when webkitSpeechRecognition is absent
 *   3. start() sets listening=true and calls recognition.start()
 *   4. result event with FINAL transcript invokes onTranscript with the text
 *   5. result event with INTERIM-ONLY results does NOT invoke onTranscript
 *   6. stop() sets listening=false and calls recognition.stop()
 *   7. onend event sets listening=false
 *   8. onerror event sets listening=false
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Minimal synchronous hook runtime (no DOM, no VDOM needed)
// ---------------------------------------------------------------------------

/** Cells filled during a single hook call. Reset before each test. */
let stateCells: { value: unknown; setter: (v: unknown) => void }[] = [];
let refCells: { current: unknown }[] = [];
let cellIdx = 0;
let refIdx = 0;
let effectCallbacks: (() => void | (() => void))[] = [];

function resetRuntime() {
  stateCells = [];
  refCells = [];
  cellIdx = 0;
  refIdx = 0;
  effectCallbacks = [];
}

/** Run all registered useEffect callbacks (synchronously). */
function flushEffects() {
  effectCallbacks.forEach((fn) => fn());
}

// Mock preact/hooks before importing speech.ts
vi.mock("preact/hooks", () => ({
  useState(initial: unknown) {
    if (cellIdx >= stateCells.length) {
      let _val = initial;
      const cell = {
        get value() { return _val; },
        setter: (v: unknown) => { _val = v; cell.value; /* trigger re-read */ },
      };
      // Make value writable via property
      Object.defineProperty(cell, "value", {
        get: () => _val,
        set: (v) => { _val = v; },
        configurable: true,
      });
      stateCells.push(cell);
    }
    const cell = stateCells[cellIdx++];
    return [cell.value, (v: unknown) => { cell.value = typeof v === "function" ? (v as (prev: unknown) => unknown)(cell.value) : v; }];
  },
  useRef(initial: unknown) {
    if (refIdx >= refCells.length) {
      refCells.push({ current: initial });
    }
    return refCells[refIdx++];
  },
  useEffect(fn: () => void | (() => void)) {
    effectCallbacks.push(fn);
  },
}));

// Also mock preact itself (imported for the void h; line in the hook)
vi.mock("preact", () => ({
  h: () => null,
  render: () => null,
}));

// Now import the hook (after mocks are registered)
import { useSpeechRecognition } from "../src/sidepanel/lib/speech.js";

// ---------------------------------------------------------------------------
// Fake SpeechRecognition instance
// ---------------------------------------------------------------------------

interface FakeRec {
  interimResults: boolean;
  continuous: boolean;
  lang: string;
  onresult: ((e: unknown) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: unknown) => void) | null;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  _fireResult(transcript: string, isFinal: boolean): void;
  _fireEnd(): void;
  _fireError(): void;
}

let lastRec: FakeRec | null = null;

function makeFakeClass() {
  class FakeRecognition implements FakeRec {
    interimResults = false;
    continuous = false;
    lang = "";
    onresult: ((e: unknown) => void) | null = null;
    onend: (() => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    start = vi.fn();
    stop = vi.fn();
    constructor() { lastRec = this; }

    _fireResult(transcript: string, isFinal: boolean) {
      if (!this.onresult) return;
      this.onresult({
        resultIndex: 0,
        results: {
          length: 1,
          0: { isFinal, length: 1, 0: { transcript, confidence: 1 } },
          item: (i: number) => (i === 0 ? { isFinal, length: 1, 0: { transcript, confidence: 1 } } : null),
        },
      });
    }
    _fireEnd() { this.onend?.(); }
    _fireError() { this.onerror?.({}); }
  }
  return FakeRecognition;
}

/** Call the hook once and return the API + a reference to the listening state cell. */
function callHook(onTranscript: (t: string) => void) {
  resetRuntime();
  const api = useSpeechRecognition(onTranscript);
  flushEffects();
  // Re-read listening from the state cell (index 0)
  return { api, listeningCell: stateCells[0] };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useSpeechRecognition (free-browser-agent)", () => {
  beforeEach(() => {
    lastRec = null;
    (globalThis as Record<string, unknown>).window = globalThis;
    (globalThis as Record<string, unknown>).webkitSpeechRecognition = makeFakeClass();
    delete (globalThis as Record<string, unknown>).SpeechRecognition;
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).webkitSpeechRecognition;
    vi.restoreAllMocks();
  });

  it("1. supported=true when webkitSpeechRecognition is present", () => {
    const { api } = callHook(vi.fn());
    expect(api.supported).toBe(true);
  });

  it("2. supported=false when webkitSpeechRecognition is absent", () => {
    delete (globalThis as Record<string, unknown>).webkitSpeechRecognition;
    const { api } = callHook(vi.fn());
    expect(api.supported).toBe(false);
  });

  it("3. start() sets listening=true and calls recognition.start()", () => {
    const { api, listeningCell } = callHook(vi.fn());
    expect(listeningCell.value).toBe(false);

    api.start();

    expect(listeningCell.value).toBe(true);
    expect(lastRec).not.toBeNull();
    expect(lastRec!.start).toHaveBeenCalledTimes(1);
  });

  it("4. result event with FINAL transcript invokes onTranscript with the text", () => {
    const onTranscript = vi.fn();
    const { api } = callHook(onTranscript);

    api.start();
    lastRec!._fireResult("hello world", true);

    expect(onTranscript).toHaveBeenCalledTimes(1);
    expect(onTranscript).toHaveBeenCalledWith("hello world");
  });

  it("5. result event with INTERIM-ONLY transcript does NOT invoke onTranscript", () => {
    const onTranscript = vi.fn();
    const { api } = callHook(onTranscript);

    api.start();
    lastRec!._fireResult("hel", false);

    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("6. stop() sets listening=false and calls recognition.stop()", () => {
    const onTranscript = vi.fn();
    const { api, listeningCell } = callHook(onTranscript);

    api.start();
    expect(listeningCell.value).toBe(true);

    // Re-call the hook with the new state to get a fresh closure where
    // listening=true (simulates a re-render after start()).
    cellIdx = 0; refIdx = 0;
    const api2 = useSpeechRecognition(onTranscript);

    api2.stop();
    expect(listeningCell.value).toBe(false);
    expect(lastRec!.stop).toHaveBeenCalledTimes(1);
  });

  it("7. onend event sets listening=false", () => {
    const { api, listeningCell } = callHook(vi.fn());

    api.start();
    expect(listeningCell.value).toBe(true);

    lastRec!._fireEnd();
    expect(listeningCell.value).toBe(false);
  });

  it("8. onerror event sets listening=false", () => {
    const { api, listeningCell } = callHook(vi.fn());

    api.start();
    expect(listeningCell.value).toBe(true);

    lastRec!._fireError();
    expect(listeningCell.value).toBe(false);
  });
});
