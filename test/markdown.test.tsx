/** @jsxImportSource preact */
import { h } from "preact";
import { render } from "preact";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Markdown } from "../src/sidepanel/Markdown.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  render(null, container);
  container.remove();
});

function renderMd(source: string): HTMLDivElement {
  render(h(Markdown, { source }), container);
  return container;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Markdown renderer", () => {
  it("renders plain text as a paragraph", () => {
    const el = renderMd("Hello world");
    const p = el.querySelector("p");
    expect(p).not.toBeNull();
    expect(p!.textContent).toBe("Hello world");
  });

  it("renders **bold** as <strong>", () => {
    const el = renderMd("This is **bold** text");
    const strong = el.querySelector("strong");
    expect(strong).not.toBeNull();
    expect(strong!.textContent).toBe("bold");
  });

  it("renders inline `code` as <code>", () => {
    const el = renderMd("Run `npm install` now");
    const code = el.querySelector("code");
    expect(code).not.toBeNull();
    expect(code!.textContent).toBe("npm install");
  });

  it("renders fenced code block as <pre>", () => {
    const source = "```js\nconsole.log('hello')\n```";
    const el = renderMd(source);
    const pre = el.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toContain("console.log('hello')");
  });

  it("renders [link](url) as <a target=_blank>", () => {
    const el = renderMd("[Click here](https://example.com)");
    const a = el.querySelector("a");
    expect(a).not.toBeNull();
    expect(a!.getAttribute("href")).toBe("https://example.com");
    expect(a!.getAttribute("target")).toBe("_blank");
    expect(a!.getAttribute("rel")).toContain("noopener");
    expect(a!.textContent).toBe("Click here");
  });

  it("renders - list as <ul><li>", () => {
    const el = renderMd("- item one\n- item two\n- item three");
    const ul = el.querySelector("ul");
    expect(ul).not.toBeNull();
    const items = ul!.querySelectorAll("li");
    expect(items.length).toBe(3);
    expect(items[0].textContent).toBe("item one");
    expect(items[2].textContent).toBe("item three");
  });

  it("renders 1. list as <ol><li>", () => {
    const el = renderMd("1. first\n2. second");
    const ol = el.querySelector("ol");
    expect(ol).not.toBeNull();
    const items = ol!.querySelectorAll("li");
    expect(items.length).toBe(2);
    expect(items[0].textContent).toBe("first");
    expect(items[1].textContent).toBe("second");
  });

  it("renders # heading as <h1>", () => {
    const el = renderMd("# My Heading");
    const h1 = el.querySelector("h1");
    expect(h1).not.toBeNull();
    expect(h1!.textContent).toBe("My Heading");
  });

  it("renders ## heading as <h2>", () => {
    const el = renderMd("## Sub Heading");
    const h2 = el.querySelector("h2");
    expect(h2).not.toBeNull();
    expect(h2!.textContent).toBe("Sub Heading");
  });

  it("renders > blockquote as <blockquote>", () => {
    const el = renderMd("> This is a quote");
    const bq = el.querySelector("blockquote");
    expect(bq).not.toBeNull();
    expect(bq!.textContent).toContain("This is a quote");
  });

  it("renders empty source without crashing", () => {
    const el = renderMd("");
    // Should produce nothing (Fragment) — no crash
    expect(el).toBeTruthy();
  });

  it("applies brand color classes to inline code (re-themed from slate/sky)", () => {
    const el = renderMd("Use `const x = 1`");
    const code = el.querySelector("code");
    expect(code).not.toBeNull();
    // Should use brand-300 (indigo), NOT sky-300
    expect(code!.getAttribute("class") ?? "").toContain("brand-300");
    expect(code!.getAttribute("class") ?? "").not.toContain("sky-");
  });

  it("applies brand color classes to links (re-themed from sky)", () => {
    const el = renderMd("[docs](https://docs.example.com)");
    const a = el.querySelector("a");
    expect(a).not.toBeNull();
    // Should use brand-400 (indigo), NOT sky-400
    expect(a!.getAttribute("class") ?? "").toContain("brand-400");
    expect(a!.getAttribute("class") ?? "").not.toContain("sky-");
  });
});
