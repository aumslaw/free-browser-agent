/**
 * DOM Operations module — runs in the content script context.
 *
 * Every exported function returns a typed result object with:
 *   ok: boolean  — whether the operation succeeded
 *   escalate?: "cdp"  — set when the op needs CDP to succeed (cross-origin
 *                        iframe, isTrusted requirement, etc.)
 *   error?: string    — human-readable failure reason
 */

// ---------------------------------------------------------------------------
// Selector helpers
// ---------------------------------------------------------------------------

/**
 * A selector can be a CSS string, or an object spec like
 * {role: "button", name: "Search"} which resolves via ARIA / visible text.
 */
export type SelectorSpec =
  | string
  | { role: string; name: string };

/** Tags whose value lives in `.value` rather than textContent */
const VALUE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * Resolve a SelectorSpec to the first *visible* matching element, or null.
 *
 * "Visible" means: not hidden via display:none / visibility:hidden /
 * opacity:0 / zero bounding box.
 */
export function resolveElement(spec: SelectorSpec): Element | null {
  const candidates = resolveAll(spec);
  return candidates.find(isVisible) ?? null;
}

/** Resolve to ALL matching elements (visible or not). */
function resolveAll(spec: SelectorSpec): Element[] {
  if (typeof spec === "string") {
    try {
      return Array.from(document.querySelectorAll(spec));
    } catch {
      return [];
    }
  }

  // {role, name} — search by aria-role + aria-label, then by visible text
  const { role, name } = spec;
  const roleLower = role.toLowerCase();
  const byAria = Array.from(
    document.querySelectorAll(`[role="${roleLower}"]`)
  ).filter((el) => {
    const label =
      el.getAttribute("aria-label") ??
      el.getAttribute("aria-labelledby") ??
      el.textContent ??
      "";
    return label.trim().toLowerCase().includes(name.toLowerCase());
  });

  if (byAria.length > 0) return byAria;

  // Fall back: native tag by role mapping + visible text
  const tagMap: Record<string, string> = {
    button: "button",
    link: "a",
    textbox: "input",
    checkbox: "input[type=checkbox]",
    radio: "input[type=radio]",
    combobox: "select",
    listitem: "li",
  };
  const tag = tagMap[roleLower] ?? roleLower;
  return Array.from(document.querySelectorAll(tag)).filter((el) => {
    const text = (el.textContent ?? "").trim();
    const ariaLabel = el.getAttribute("aria-label") ?? "";
    const title = el.getAttribute("title") ?? "";
    return (
      text.toLowerCase().includes(name.toLowerCase()) ||
      ariaLabel.toLowerCase().includes(name.toLowerCase()) ||
      title.toLowerCase().includes(name.toLowerCase())
    );
  });
}

/** Returns true when an element is visible on-screen. */
function isVisible(el: Element): boolean {
  const style = window.getComputedStyle(el);
  if (style.display === "none") return false;
  if (style.visibility === "hidden") return false;
  if (parseFloat(style.opacity) === 0) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/** Detect if an element lives inside a cross-origin iframe. */
function isCrossOriginFrame(el: Element): boolean {
  let node: Element | null = el;
  while (node) {
    const owner = node.ownerDocument;
    if (owner !== document) {
      try {
        // If we can read the href we're same-origin; cross-origin throws
        const win = owner.defaultView;
        void win?.location.href;
        return false;
      } catch {
        return true;
      }
    }
    node = node.parentElement;
  }
  return false;
}

// ---------------------------------------------------------------------------
// click
// ---------------------------------------------------------------------------

export interface ClickResult {
  ok: boolean;
  escalate?: "cdp";
  error?: string;
}

/**
 * Click the first visible element matching `spec`.
 *
 * Escalates to CDP when:
 *  - The element is inside a cross-origin iframe
 *  - el.click() throws (some protected inputs require isTrusted events)
 */
export function click(spec: SelectorSpec): ClickResult {
  const el = resolveElement(spec);
  if (!el) {
    return { ok: false, error: `No visible element matching: ${JSON.stringify(spec)}` };
  }
  if (isCrossOriginFrame(el)) {
    return { ok: false, escalate: "cdp", error: "cross-origin iframe" };
  }
  try {
    (el as HTMLElement).focus?.();
    (el as HTMLElement).click();
    return { ok: true };
  } catch (e) {
    // Some inputs (file, clipboard) require isTrusted events
    return { ok: false, escalate: "cdp", error: String(e) };
  }
}

// ---------------------------------------------------------------------------
// type
// ---------------------------------------------------------------------------

export interface TypeResult {
  ok: boolean;
  error?: string;
}

/**
 * Type text into the first visible element matching `selector`.
 *
 * Supports:
 *  - `<input>` and `<textarea>` — sets .value + fires `input` + `change`
 *  - `contenteditable` — sets textContent + fires `input`
 */
export function type(selector: SelectorSpec, text: string): TypeResult {
  const el = resolveElement(selector);
  if (!el) {
    return { ok: false, error: `No visible element matching: ${JSON.stringify(selector)}` };
  }

  const tag = el.tagName;

  if (VALUE_TAGS.has(tag)) {
    const input = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    // Use native input setter to bypass React/Vue synthetic event wrappers
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      tag === "TEXTAREA"
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype,
      "value"
    )?.set;
    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(input, text);
    } else {
      (input as HTMLInputElement).value = text;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true };
  }

  // Detect contenteditable via the property (true for inherited editability) OR
  // the attribute (`contenteditable=""` / `"true"`). The attribute fallback is
  // load-bearing: `isContentEditable` is undefined until layout is computed and
  // is unimplemented in some DOM environments, so the property alone misses
  // genuinely-editable elements.
  const ceAttr = (el as HTMLElement).getAttribute("contenteditable");
  if ((el as HTMLElement).isContentEditable || ceAttr === "" || ceAttr === "true") {
    (el as HTMLElement).focus();
    (el as HTMLElement).textContent = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return { ok: true };
  }

  return { ok: false, error: `Element is not a typeable field: ${tag}` };
}

// ---------------------------------------------------------------------------
// fillForm
// ---------------------------------------------------------------------------

export interface FillFormResult {
  ok: boolean;
  filled: string[];
  errors: Record<string, string>;
}

/**
 * Fill multiple form fields in one call.
 *
 * `spec` maps CSS-selector-or-spec → value.
 * Returns the list of selectors that were successfully filled.
 */
export function fillForm(
  spec: Record<string, string>
): FillFormResult {
  const filled: string[] = [];
  const errors: Record<string, string> = {};

  for (const [selector, value] of Object.entries(spec)) {
    const result = type(selector, value);
    if (result.ok) {
      filled.push(selector);
    } else {
      errors[selector] = result.error ?? "unknown error";
    }
  }

  return { ok: Object.keys(errors).length === 0, filled, errors };
}

// ---------------------------------------------------------------------------
// scroll
// ---------------------------------------------------------------------------

export interface ScrollResult {
  ok: boolean;
  error?: string;
}

export type ScrollTarget =
  | { x: number; y: number }
  | { selector: SelectorSpec };

/**
 * Scroll to a coordinate pair or to bring an element into view.
 */
export function scroll(target: ScrollTarget): ScrollResult {
  if ("selector" in target) {
    const el = resolveElement(target.selector);
    if (!el) {
      return {
        ok: false,
        error: `No visible element matching: ${JSON.stringify(target.selector)}`,
      };
    }
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    return { ok: true };
  }

  window.scrollTo({ left: target.x, top: target.y, behavior: "smooth" });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// waitForSelector
// ---------------------------------------------------------------------------

export interface WaitResult {
  ok: boolean;
  found: boolean;
  error?: string;
}

/**
 * Poll for `selector` to appear in the DOM and be visible.
 * Resolves with `{found:true}` as soon as the element appears, or
 * `{found:false}` when `timeoutMs` elapses.
 */
export function waitForSelector(
  selector: SelectorSpec,
  timeoutMs = 5000
): Promise<WaitResult> {
  return new Promise((resolve) => {
    // Fast path — already present
    const immediate = resolveElement(selector);
    if (immediate) {
      resolve({ ok: true, found: true });
      return;
    }

    const start = Date.now();
    const interval = 100; // poll every 100 ms

    const timer = setInterval(() => {
      const el = resolveElement(selector);
      if (el) {
        clearInterval(timer);
        resolve({ ok: true, found: true });
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        clearInterval(timer);
        resolve({ ok: true, found: false });
      }
    }, interval);
  });
}

// ---------------------------------------------------------------------------
// getUrl
// ---------------------------------------------------------------------------

export interface GetUrlResult {
  ok: boolean;
  url?: string;
  error?: string;
}

export function getUrl(): GetUrlResult {
  try {
    return { ok: true, url: window.location.href };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ---------------------------------------------------------------------------
// getSelection
// ---------------------------------------------------------------------------

export interface GetSelectionResult {
  ok: boolean;
  text?: string;
  error?: string;
}

export function getSelection(): GetSelectionResult {
  try {
    const sel = window.getSelection();
    return { ok: true, text: sel?.toString() ?? "" };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ---------------------------------------------------------------------------
// readText
// ---------------------------------------------------------------------------

export interface ReadTextResult {
  ok: boolean;
  text?: string;
  error?: string;
}

/**
 * Read the visible text content of the first visible element matching `spec`.
 *
 * For INPUT/TEXTAREA/SELECT elements, returns `.value`.
 * For all other elements, returns `.textContent` / `.innerText` trimmed.
 * Returns ok:false + error when no element is found.
 */
export function readText(spec: SelectorSpec): ReadTextResult {
  const el = resolveElement(spec);
  if (!el) {
    return { ok: false, error: `No visible element matching: ${JSON.stringify(spec)}` };
  }
  try {
    let text: string;
    if (VALUE_TAGS.has(el.tagName)) {
      text = (el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value ?? "";
    } else {
      // Prefer innerText (rendered text) when available; fall back to textContent
      text =
        ((el as HTMLElement).innerText ?? (el as HTMLElement).textContent ?? "").trim();
    }
    return { ok: true, text: text.trim() };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ---------------------------------------------------------------------------
// getElementCoords
// ---------------------------------------------------------------------------

export interface GetElementCoordsResult {
  ok: boolean;
  x?: number;
  y?: number;
  error?: string;
}

/**
 * Return the viewport-center coordinates of the first visible element matching `spec`.
 *
 * Uses `getBoundingClientRect()`:
 *   x = left + width  / 2  (horizontal center)
 *   y = top  + height / 2  (vertical center)
 *
 * Returns ok:false + error when no element is found or the element has a zero-area rect.
 */
export function getElementCoords(spec: SelectorSpec): GetElementCoordsResult {
  const el = resolveElement(spec);
  if (!el) {
    return { ok: false, error: `No visible element matching: ${JSON.stringify(spec)}` };
  }
  try {
    const rect = (el as HTMLElement).getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      return { ok: false, error: `Element has zero-area bounding rect: ${JSON.stringify(spec)}` };
    }
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    return { ok: true, x, y };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ---------------------------------------------------------------------------
// domDigest — lightweight page summary for auto-attach and readPage
// ---------------------------------------------------------------------------

export interface FormField {
  name: string;
  type: string;
  id?: string;
  placeholder?: string;
  label?: string;
}

export interface DomDigest {
  url: string;
  title: string;
  headings: string[];
  links: { text: string; href: string }[];
  formFields: FormField[];
  selectedText?: string;
}

/**
 * Produce a compact structural digest of the current page.
 * Used by the agent to understand page context without sending full HTML.
 */
export function domDigest(): DomDigest {
  const url = window.location.href;
  const title = document.title;

  // Collect visible headings (h1–h3)
  const headings: string[] = [];
  document.querySelectorAll("h1, h2, h3").forEach((h) => {
    const text = (h.textContent ?? "").trim();
    if (text && isVisible(h)) headings.push(text);
  });

  // Collect up to 40 visible, non-empty links
  const links: { text: string; href: string }[] = [];
  document.querySelectorAll("a[href]").forEach((a) => {
    if (links.length >= 40) return;
    const href = (a as HTMLAnchorElement).href;
    const text = (a.textContent ?? "").trim();
    if (text && href && !href.startsWith("javascript:") && isVisible(a)) {
      links.push({ text, href });
    }
  });

  // Collect form fields (input, textarea, select)
  const formFields: FormField[] = [];
  document.querySelectorAll("input, textarea, select").forEach((el) => {
    const input = el as HTMLInputElement;
    const name =
      input.name ||
      input.id ||
      input.getAttribute("aria-label") ||
      input.placeholder ||
      "";
    const type = input.type || el.tagName.toLowerCase();
    if (type === "hidden") return; // skip hidden inputs
    // Try to find associated <label>
    let label: string | undefined;
    if (input.id) {
      const labelEl = document.querySelector(`label[for="${input.id}"]`);
      label = labelEl?.textContent?.trim();
    }
    formFields.push({
      name,
      type,
      id: input.id || undefined,
      placeholder: input.placeholder || undefined,
      label,
    });
  });

  const selectedText = window.getSelection()?.toString() || undefined;

  return { url, title, headings, links, formFields, selectedText };
}

// ---------------------------------------------------------------------------
// readPage — full Readability-style markdown extraction
// ---------------------------------------------------------------------------

export interface ReadPageResult {
  ok: boolean;
  markdown?: string;
  error?: string;
}

/** Tags we skip entirely during extraction (navigation / decorative). */
const SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
  "SVG",
  "CANVAS",
  "IFRAME",
  "OBJECT",
  "EMBED",
  "HEADER",
  "FOOTER",
  "NAV",
  "ASIDE",
]);

/** Block tags that should be separated by blank lines. */
const BLOCK_TAGS = new Set([
  "P",
  "DIV",
  "SECTION",
  "ARTICLE",
  "BLOCKQUOTE",
  "PRE",
  "UL",
  "OL",
  "TABLE",
  "FIGURE",
  "MAIN",
]);

/**
 * Extract a clean markdown representation of the page body.
 *
 * Strategy:
 *  1. Find the main content container (prefer <main>, <article>, or the element
 *     with the highest paragraph density).
 *  2. Walk its DOM tree, converting semantic tags to markdown.
 *  3. Truncate to 8 000 chars to stay within LLM context budgets.
 */
export function readPage(): ReadPageResult {
  try {
    // Pick the best content root
    const root = pickContentRoot();
    const lines: string[] = [];

    // Always include the page title at the top
    const title = document.title.trim();
    if (title) {
      lines.push(`# ${title}`);
      lines.push("");
    }

    extractNode(root, lines, 0);

    // Deduplicate consecutive blank lines
    const deduped: string[] = [];
    let lastBlank = false;
    for (const line of lines) {
      const blank = line.trim() === "";
      if (blank && lastBlank) continue;
      deduped.push(line);
      lastBlank = blank;
    }

    const markdown = deduped.join("\n").trim();
    // Truncate if enormous
    const truncated =
      markdown.length > 8000
        ? markdown.slice(0, 8000) + "\n\n…(truncated)"
        : markdown;

    return { ok: true, markdown: truncated };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Pick the most content-dense element to use as the extraction root. */
function pickContentRoot(): Element {
  // Prefer explicit semantic containers
  const candidates = [
    document.querySelector("main"),
    document.querySelector("article"),
    document.querySelector('[role="main"]'),
    document.querySelector("#content"),
    document.querySelector(".content"),
    document.querySelector(".post"),
    document.querySelector(".entry"),
  ].filter((el): el is Element => el !== null && isVisible(el));

  if (candidates.length > 0) return candidates[0];

  // Fallback: pick the child of body with the most <p> tags
  let best: Element = document.body;
  let maxP = 0;
  document.body.children &&
    Array.from(document.body.children).forEach((child) => {
      const count = child.querySelectorAll("p").length;
      if (count > maxP) {
        maxP = count;
        best = child;
      }
    });

  return best;
}

/** Recursively convert a DOM node to markdown lines. */
function extractNode(node: Node, lines: string[], depth: number): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text) {
      // Append inline to the last line if it exists and is non-empty
      if (lines.length > 0 && lines[lines.length - 1].trim() !== "") {
        lines[lines.length - 1] += " " + text;
      } else {
        lines.push(text);
      }
    }
    return;
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return;

  const el = node as Element;
  const tag = el.tagName;

  // Skip non-content tags
  if (SKIP_TAGS.has(tag)) return;
  if (!isVisible(el)) return;

  // Headings
  if (/^H[1-6]$/.test(tag)) {
    const level = parseInt(tag[1], 10);
    const prefix = "#".repeat(level);
    const text = (el.textContent ?? "").trim();
    if (text) {
      lines.push("");
      lines.push(`${prefix} ${text}`);
      lines.push("");
    }
    return; // don't recurse — heading text already captured
  }

  // Links — render as [text](href) but still recurse for nested content
  if (tag === "A") {
    const href = (el as HTMLAnchorElement).href;
    const text = (el.textContent ?? "").trim();
    if (text && href && !href.startsWith("javascript:")) {
      if (lines.length > 0 && lines[lines.length - 1].trim() !== "") {
        lines[lines.length - 1] += ` [${text}](${href})`;
      } else {
        lines.push(`[${text}](${href})`);
      }
      return; // text already captured
    }
    // Fall through to recurse if link has no text
  }

  // Images — render alt text
  if (tag === "IMG") {
    const alt = (el as HTMLImageElement).alt?.trim();
    if (alt) lines.push(`![${alt}]`);
    return;
  }

  // List items
  if (tag === "LI") {
    lines.push("");
    const parentTag = el.parentElement?.tagName ?? "";
    const bullet = parentTag === "OL" ? "1." : "-";
    // Gather child text first, then prefix
    const childLines: string[] = [];
    for (const child of Array.from(el.childNodes)) {
      extractNode(child, childLines, depth + 1);
    }
    const text = childLines.join(" ").replace(/\s+/g, " ").trim();
    if (text) lines.push(`${bullet} ${text}`);
    return;
  }

  // Block elements — add blank lines around their content
  if (BLOCK_TAGS.has(tag)) {
    lines.push("");
    for (const child of Array.from(el.childNodes)) {
      extractNode(child, lines, depth + 1);
    }
    lines.push("");
    return;
  }

  // Strong / em
  if (tag === "STRONG" || tag === "B") {
    const text = (el.textContent ?? "").trim();
    if (text) {
      if (lines.length > 0 && lines[lines.length - 1].trim() !== "") {
        lines[lines.length - 1] += ` **${text}**`;
      } else {
        lines.push(`**${text}**`);
      }
    }
    return;
  }

  if (tag === "EM" || tag === "I") {
    const text = (el.textContent ?? "").trim();
    if (text) {
      if (lines.length > 0 && lines[lines.length - 1].trim() !== "") {
        lines[lines.length - 1] += ` _${text}_`;
      } else {
        lines.push(`_${text}_`);
      }
    }
    return;
  }

  // Code blocks
  if (tag === "PRE" || tag === "CODE") {
    const text = (el.textContent ?? "").trim();
    if (text) {
      lines.push("");
      lines.push("```");
      lines.push(text);
      lines.push("```");
      lines.push("");
    }
    return;
  }

  // Default: recurse into children
  for (const child of Array.from(el.childNodes)) {
    extractNode(child, lines, depth + 1);
  }
}
