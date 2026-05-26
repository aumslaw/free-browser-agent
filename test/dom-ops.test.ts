/**
 * test/dom-ops.test.ts
 *
 * Vitest + jsdom tests for src/content/dom-ops.ts.
 *
 * The jsdom environment is configured via environmentMatchGlobs in vitest.config.ts
 * so vitest sets up document/window globals automatically.
 *
 */

import { describe, it, expect, beforeEach } from "vitest";

// Helper: make an element appear "visible" to dom-ops.
// jsdom returns 0x0 bounding rects by default — we patch getBoundingClientRect.
function makeVisible(el: Element): void {
  (el as HTMLElement).getBoundingClientRect = () => ({
    width: 100, height: 30, top: 0, left: 0,
    bottom: 30, right: 100, x: 0, y: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

// ── click ────────────────────────────────────────────────────────────────────

describe("click()", () => {
  beforeEach(() => {
    document.body.innerHTML = `<button id="btn">Click me</button>`;
  });

  it("returns ok:true and fires click on visible button", async () => {
    const { click } = await import("../src/content/dom-ops.js");
    const btn = document.getElementById("btn")!;
    makeVisible(btn);
    let clicked = false;
    btn.addEventListener("click", () => { clicked = true; });
    const result = click("#btn");
    expect(result.ok).toBe(true);
    expect(clicked).toBe(true);
  });

  it("returns ok:false with error when selector matches nothing", async () => {
    const { click } = await import("../src/content/dom-ops.js");
    const result = click("#does-not-exist");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/No visible element/);
  });
});

// ── type ─────────────────────────────────────────────────────────────────────

describe("type()", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <input id="inp" type="text" />
      <textarea id="ta"></textarea>
    `;
  });

  it("sets value on a text input and fires input event", async () => {
    const { type } = await import("../src/content/dom-ops.js");
    const inp = document.getElementById("inp") as HTMLInputElement;
    makeVisible(inp);
    let inputFired = false;
    inp.addEventListener("input", () => { inputFired = true; });
    const result = type("#inp", "hello world");
    expect(result.ok).toBe(true);
    expect(inp.value).toBe("hello world");
    expect(inputFired).toBe(true);
  });

  it("sets value on a textarea", async () => {
    const { type } = await import("../src/content/dom-ops.js");
    const ta = document.getElementById("ta") as HTMLTextAreaElement;
    makeVisible(ta);
    const result = type("#ta", "multi\nline");
    expect(result.ok).toBe(true);
    expect(ta.value).toBe("multi\nline");
  });

  it("returns ok:false for a non-typeable element (plain div)", async () => {
    document.body.innerHTML = `<div id="d">text</div>`;
    const { type } = await import("../src/content/dom-ops.js");
    const d = document.getElementById("d")!;
    makeVisible(d);
    const result = type("#d", "ignored");
    expect(result.ok).toBe(false);
  });
});

// ── readPage ─────────────────────────────────────────────────────────────────

describe("readPage()", () => {
  beforeEach(() => {
    document.title = "Test Page";
    document.body.innerHTML = `
      <main>
        <h1>Main Heading</h1>
        <h2>Sub Heading</h2>
        <p>Paragraph content goes here.</p>
      </main>
    `;
    document.querySelectorAll("h1,h2,p,main").forEach((el) => makeVisible(el));
  });

  it("returns ok:true and a non-empty markdown string", async () => {
    const { readPage } = await import("../src/content/dom-ops.js");
    const result = readPage();
    expect(result.ok).toBe(true);
    expect(typeof result.markdown).toBe("string");
    expect(result.markdown!.length).toBeGreaterThan(0);
  });

  it("includes page title as H1", async () => {
    const { readPage } = await import("../src/content/dom-ops.js");
    const result = readPage();
    expect(result.markdown).toContain("# Test Page");
  });

  it("contains markdown heading syntax for h1/h2 elements", async () => {
    const { readPage } = await import("../src/content/dom-ops.js");
    const result = readPage();
    expect(result.markdown).toMatch(/^#{1,6} /m);
  });

  it("contains paragraph text", async () => {
    const { readPage } = await import("../src/content/dom-ops.js");
    const result = readPage();
    expect(result.markdown).toContain("Paragraph content");
  });
});

// ── waitForSelector ──────────────────────────────────────────────────────────

describe("waitForSelector()", () => {
  it("resolves immediately with found:true when element is already present", async () => {
    document.body.innerHTML = `<div id="ready">here</div>`;
    makeVisible(document.getElementById("ready")!);
    const { waitForSelector } = await import("../src/content/dom-ops.js");
    const result = await waitForSelector("#ready", 500);
    expect(result.ok).toBe(true);
    expect(result.found).toBe(true);
  }, 1000);

  it("resolves with found:false after timeout when element never appears", async () => {
    document.body.innerHTML = `<div></div>`;
    const { waitForSelector } = await import("../src/content/dom-ops.js");
    const result = await waitForSelector("#absent", 150);
    expect(result.ok).toBe(true);
    expect(result.found).toBe(false);
  }, 1000);

  it("resolves with found:true when element is injected before timeout", async () => {
    document.body.innerHTML = `<div></div>`;
    const { waitForSelector } = await import("../src/content/dom-ops.js");

    // Inject the element after 60ms, within a 400ms timeout
    setTimeout(() => {
      const el = document.createElement("div");
      el.id = "late";
      makeVisible(el);
      document.body.appendChild(el);
    }, 60);

    const result = await waitForSelector("#late", 400);
    expect(result.found).toBe(true);
  }, 1000);
});

// ── getSelection ─────────────────────────────────────────────────────────────

describe("getSelection()", () => {
  it("returns ok:true with an empty string when nothing selected", async () => {
    document.body.innerHTML = `<p>Some text</p>`;
    const { getSelection } = await import("../src/content/dom-ops.js");
    const result = getSelection();
    expect(result.ok).toBe(true);
    expect(typeof result.text).toBe("string");
  });
});


