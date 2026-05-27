/**
 * test/dom-ops.test.ts
 *
 * Vitest + jsdom tests for src/content/dom-ops.ts.
 *
 * The jsdom environment is configured via environmentMatchGlobs in vitest.config.ts
 * so vitest sets up document/window globals automatically.
 *
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

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

// ── fillForm ─────────────────────────────────────────────────────────────────

describe("fillForm()", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <input id="first" type="text" />
      <input id="last" type="text" />
      <textarea id="bio"></textarea>
    `;
    ["first", "last", "bio"].forEach((id) => {
      makeVisible(document.getElementById(id)!);
    });
  });

  it("fills multiple fields and returns ok:true with all selectors in filled[]", async () => {
    const { fillForm } = await import("../src/content/dom-ops.js");
    const result = fillForm({ "#first": "Alice", "#last": "Smith", "#bio": "Developer" });
    expect(result.ok).toBe(true);
    expect(result.filled).toContain("#first");
    expect(result.filled).toContain("#last");
    expect(result.filled).toContain("#bio");
    expect(result.errors).toEqual({});
    expect((document.getElementById("first") as HTMLInputElement).value).toBe("Alice");
    expect((document.getElementById("last") as HTMLInputElement).value).toBe("Smith");
    expect((document.getElementById("bio") as HTMLTextAreaElement).value).toBe("Developer");
  });

  it("returns ok:false with errors map when one selector doesn't exist", async () => {
    const { fillForm } = await import("../src/content/dom-ops.js");
    const result = fillForm({ "#first": "Alice", "#nonexistent": "ignored" });
    expect(result.ok).toBe(false);
    expect(result.filled).toContain("#first");
    expect("#nonexistent" in result.errors).toBe(true);
    expect(result.errors["#nonexistent"]).toBeTruthy();
  });

  it("returns ok:true for an empty spec (no fields to fill)", async () => {
    const { fillForm } = await import("../src/content/dom-ops.js");
    const result = fillForm({});
    expect(result.ok).toBe(true);
    expect(result.filled).toHaveLength(0);
    expect(result.errors).toEqual({});
  });

  it("reports all errors when every selector is invalid", async () => {
    const { fillForm } = await import("../src/content/dom-ops.js");
    const result = fillForm({ "#no-a": "x", "#no-b": "y" });
    expect(result.ok).toBe(false);
    expect(result.filled).toHaveLength(0);
    expect(Object.keys(result.errors)).toHaveLength(2);
  });
});

// ── scroll ────────────────────────────────────────────────────────────────────

describe("scroll()", () => {
  beforeEach(() => {
    document.body.innerHTML = `<div id="target" style="height:200px;">scroll target</div>`;
    makeVisible(document.getElementById("target")!);
    // jsdom doesn't throw on window.scrollTo — it just no-ops; we can spy on it
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  });

  it("returns ok:true when scrolling to an existing selector", async () => {
    const { scroll } = await import("../src/content/dom-ops.js");
    // jsdom does not implement scrollIntoView — patch it on the target element
    const target = document.getElementById("target")!;
    target.scrollIntoView = vi.fn();
    const result = scroll({ selector: "#target" });
    expect(result.ok).toBe(true);
    expect(target.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
  });

  it("returns ok:false when scrolling to a missing selector", async () => {
    const { scroll } = await import("../src/content/dom-ops.js");
    const result = scroll({ selector: "#missing" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/No visible element/);
  });

  it("returns ok:true when scrolling to x/y coordinates", async () => {
    const { scroll } = await import("../src/content/dom-ops.js");
    const result = scroll({ x: 0, y: 500 });
    expect(result.ok).toBe(true);
    expect(window.scrollTo).toHaveBeenCalledWith({ left: 0, top: 500, behavior: "smooth" });
  });
});

// ── getUrl ────────────────────────────────────────────────────────────────────

describe("getUrl()", () => {
  it("returns ok:true and the current window.location.href", async () => {
    const { getUrl } = await import("../src/content/dom-ops.js");
    const result = getUrl();
    expect(result.ok).toBe(true);
    // jsdom sets location.href to "about:blank" by default
    expect(typeof result.url).toBe("string");
    expect(result.url!.length).toBeGreaterThan(0);
  });
});

// ── resolveElement — {role, name} ARIA spec ───────────────────────────────────

describe("resolveElement() — {role, name} ARIA spec", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <button id="sb" aria-label="Search">Search</button>
      <a id="lnk" href="#">Help link</a>
      <div id="dlg" role="dialog" aria-label="Confirm deletion">Delete?</div>
    `;
    ["sb", "lnk", "dlg"].forEach((id) => {
      makeVisible(document.getElementById(id)!);
    });
  });

  it("finds a button by role+name via aria-label", async () => {
    const { resolveElement } = await import("../src/content/dom-ops.js");
    const el = resolveElement({ role: "button", name: "Search" });
    expect(el).not.toBeNull();
    expect(el!.id).toBe("sb");
  });

  it("finds an element by explicit [role] attribute + aria-label substring", async () => {
    const { resolveElement } = await import("../src/content/dom-ops.js");
    const el = resolveElement({ role: "dialog", name: "Confirm" });
    expect(el).not.toBeNull();
    expect(el!.id).toBe("dlg");
  });

  it("finds a link by role+name using visible text fallback (no aria-label)", async () => {
    const { resolveElement } = await import("../src/content/dom-ops.js");
    const el = resolveElement({ role: "link", name: "Help" });
    expect(el).not.toBeNull();
    expect(el!.id).toBe("lnk");
  });

  it("returns null when no element matches the {role, name} spec", async () => {
    const { resolveElement } = await import("../src/content/dom-ops.js");
    const el = resolveElement({ role: "button", name: "Nonexistent XYZ 99999" });
    expect(el).toBeNull();
  });
});

// ── type() — contenteditable ──────────────────────────────────────────────────

describe("type() — contenteditable", () => {
  beforeEach(() => {
    document.body.innerHTML = `<div id="ce" contenteditable="true"></div>`;
    makeVisible(document.getElementById("ce")!);
  });

  it("sets textContent on a contenteditable div and fires input event", async () => {
    const { type } = await import("../src/content/dom-ops.js");
    const ce = document.getElementById("ce") as HTMLElement;
    let inputFired = false;
    ce.addEventListener("input", () => { inputFired = true; });
    const result = type("#ce", "contenteditable text");
    expect(result.ok).toBe(true);
    expect(ce.textContent).toBe("contenteditable text");
    expect(inputFired).toBe(true);
  });
});

// ── readPage — rich tag extraction ───────────────────────────────────────────

describe("readPage() — rich tag extraction", () => {
  function makeAllVisible() {
    document.querySelectorAll("*").forEach((el) => makeVisible(el));
  }

  it("renders links as [text](href) markdown", async () => {
    document.body.innerHTML = `<main><a id="a1" href="https://example.com">Click here</a></main>`;
    makeAllVisible();
    const { readPage } = await import("../src/content/dom-ops.js");
    const result = readPage();
    expect(result.ok).toBe(true);
    expect(result.markdown).toContain("[Click here](https://example.com/)");
  });

  it("renders <strong> as **bold**", async () => {
    document.body.innerHTML = `<main><p><strong>Important</strong></p></main>`;
    makeAllVisible();
    const { readPage } = await import("../src/content/dom-ops.js");
    const result = readPage();
    expect(result.ok).toBe(true);
    expect(result.markdown).toContain("**Important**");
  });

  it("renders <em> as _italic_", async () => {
    document.body.innerHTML = `<main><p><em>Italic text</em></p></main>`;
    makeAllVisible();
    const { readPage } = await import("../src/content/dom-ops.js");
    const result = readPage();
    expect(result.ok).toBe(true);
    expect(result.markdown).toContain("_Italic text_");
  });

  it("renders <img> alt text as ![alt]", async () => {
    document.body.innerHTML = `<main><img id="img1" src="x.png" alt="A diagram" /></main>`;
    makeAllVisible();
    const { readPage } = await import("../src/content/dom-ops.js");
    const result = readPage();
    expect(result.ok).toBe(true);
    expect(result.markdown).toContain("![A diagram]");
  });

  it("renders <li> items with bullet prefix", async () => {
    document.body.innerHTML = `<main><ul><li id="li1">First item</li><li id="li2">Second item</li></ul></main>`;
    makeAllVisible();
    const { readPage } = await import("../src/content/dom-ops.js");
    const result = readPage();
    expect(result.ok).toBe(true);
    expect(result.markdown).toContain("- First item");
    expect(result.markdown).toContain("- Second item");
  });

  it("renders <ol> items with '1.' ordered prefix", async () => {
    document.body.innerHTML = `<main><ol><li id="li3">Step one</li><li id="li4">Step two</li></ol></main>`;
    makeAllVisible();
    const { readPage } = await import("../src/content/dom-ops.js");
    const result = readPage();
    expect(result.ok).toBe(true);
    expect(result.markdown).toContain("1. Step one");
    expect(result.markdown).toContain("1. Step two");
  });

  it("renders <code> blocks with triple-backtick fences", async () => {
    document.body.innerHTML = `<main><code id="code1">const x = 1;</code></main>`;
    makeAllVisible();
    const { readPage } = await import("../src/content/dom-ops.js");
    const result = readPage();
    expect(result.ok).toBe(true);
    expect(result.markdown).toContain("```");
    expect(result.markdown).toContain("const x = 1;");
  });

  it("truncates output at 8000 chars and appends '(truncated)'", async () => {
    // Build a page body with > 8000 chars of content
    const longText = "word ".repeat(2000); // 10000 chars
    document.body.innerHTML = `<main><p id="p1">${longText}</p></main>`;
    makeAllVisible();
    const { readPage } = await import("../src/content/dom-ops.js");
    const result = readPage();
    expect(result.ok).toBe(true);
    expect(result.markdown!.length).toBeLessThanOrEqual(8020); // 8000 + "...(truncated)" overhead
    expect(result.markdown).toContain("(truncated)");
  });

  it("skips elements inside <nav> (SKIP_TAGS member)", async () => {
    document.body.innerHTML = `<main><nav><a href="/skip">Skip this</a></nav><p id="p2">Keep this</p></main>`;
    makeAllVisible();
    const { readPage } = await import("../src/content/dom-ops.js");
    const result = readPage();
    expect(result.ok).toBe(true);
    // Nav link text should not appear; paragraph text should
    expect(result.markdown).not.toContain("Skip this");
    expect(result.markdown).toContain("Keep this");
  });
});

// ── domDigest ─────────────────────────────────────────────────────────────────

describe("domDigest()", () => {
  beforeEach(() => {
    document.title = "Digest Test Page";
    document.body.innerHTML = `
      <main>
        <h1 id="h1">Page Title</h1>
        <h2 id="h2">Section</h2>
        <a id="lnk" href="https://example.com">Example Link</a>
        <form>
          <input id="email" name="email" type="email" placeholder="Email" />
          <input id="name" name="username" type="text" placeholder="Name" />
          <input type="hidden" name="csrf" value="abc" />
          <select id="country" name="country"></select>
        </form>
      </main>
    `;
    ["h1", "h2", "lnk", "email", "name", "country"].forEach((id) => {
      makeVisible(document.getElementById(id)!);
    });
    makeVisible(document.querySelector("main")!);
  });

  it("returns url, title, headings, links, and formFields", async () => {
    const { domDigest } = await import("../src/content/dom-ops.js");
    const digest = domDigest();
    expect(typeof digest.url).toBe("string");
    expect(digest.title).toBe("Digest Test Page");
    expect(digest.headings).toContain("Page Title");
    expect(digest.headings).toContain("Section");
    expect(digest.links.some((l) => l.text === "Example Link" && l.href.includes("example.com"))).toBe(true);
    expect(digest.formFields.some((f) => f.type === "email")).toBe(true);
    expect(digest.formFields.some((f) => f.type === "text")).toBe(true);
  });

  it("omits hidden inputs from formFields", async () => {
    const { domDigest } = await import("../src/content/dom-ops.js");
    const digest = domDigest();
    // The hidden csrf field should be filtered out
    expect(digest.formFields.every((f) => f.type !== "hidden")).toBe(true);
  });

  it("includes selectedText when window has a selection", async () => {
    const { domDigest } = await import("../src/content/dom-ops.js");
    // Patch window.getSelection to return a fake selection
    vi.spyOn(window, "getSelection").mockReturnValueOnce({
      toString: () => "highlighted phrase",
    } as unknown as Selection);
    const digest = domDigest();
    expect(digest.selectedText).toBe("highlighted phrase");
  });

  it("returns undefined selectedText when nothing is selected", async () => {
    const { domDigest } = await import("../src/content/dom-ops.js");
    const digest = domDigest();
    // jsdom has no real selection — should be undefined or empty
    expect(digest.selectedText === undefined || digest.selectedText === "").toBe(true);
  });
});


