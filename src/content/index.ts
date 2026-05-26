/**
 * Content Script Entry Point
 *
 * Registered in manifest.json for <all_urls>, all_frames:true, run_at:document_idle.
 *
 * Listens for messages from the background service worker (via
 * chrome.runtime.sendMessage → chrome.runtime.onMessage) in the shape:
 *
 *   { kind: "dom-op", op: string, args: unknown[] }
 *
 * Dispatches to the appropriate function in dom-ops.ts and sends back
 * the result via `sendResponse`.
 *
 * Also exposes a "dom-digest" request for the agent auto-attach pattern.
 */

import {
  click,
  type,
  fillForm,
  scroll,
  waitForSelector,
  getUrl,
  getSelection,
  domDigest,
  readPage,
  type SelectorSpec,
  type ScrollTarget,
} from "./dom-ops";

// ---------------------------------------------------------------------------
// Message protocol types
// ---------------------------------------------------------------------------

/** All known op names */
type DomOpName =
  | "click"
  | "type"
  | "fillForm"
  | "scroll"
  | "waitForSelector"
  | "getUrl"
  | "getSelection"
  | "domDigest"
  | "readPage";

interface DomOpMessage {
  kind: "dom-op";
  op: DomOpName;
  args: unknown[];
}

interface DomDigestMessage {
  kind: "dom-digest";
}

type ContentMessage = DomOpMessage | DomDigestMessage;

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener(
  (
    message: ContentMessage,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void
  ): boolean => {
    // Handle dom-digest shorthand (used by auto-attach pattern)
    if (message.kind === "dom-digest") {
      try {
        sendResponse({ ok: true, result: domDigest() });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
      return false; // synchronous
    }

    if (message.kind !== "dom-op") {
      sendResponse({ ok: false, error: `Unknown message kind: ${(message as { kind: string }).kind}` });
      return false;
    }

    const { op, args } = message as DomOpMessage;

    // Async ops return true to keep the message channel open
    const isAsync = op === "waitForSelector";

    try {
      const result = dispatch(op, args);

      if (result instanceof Promise) {
        result
          .then((r) => sendResponse({ ok: true, result: r }))
          .catch((e) => sendResponse({ ok: false, error: String(e) }));
        return true; // keep channel open
      }

      sendResponse({ ok: true, result });
      return false;
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
      return isAsync; // keep open only for async
    }
  }
);

// ---------------------------------------------------------------------------
// Op dispatcher
// ---------------------------------------------------------------------------

function dispatch(op: DomOpName, args: unknown[]): unknown {
  switch (op) {
    case "click": {
      const [spec] = args as [SelectorSpec];
      return click(spec);
    }

    case "type": {
      const [selector, text] = args as [SelectorSpec, string];
      return type(selector, text);
    }

    case "fillForm": {
      const [spec] = args as [Record<string, string>];
      return fillForm(spec);
    }

    case "scroll": {
      const [target] = args as [ScrollTarget];
      return scroll(target);
    }

    case "waitForSelector": {
      const [selector, timeoutMs] = args as [SelectorSpec, number | undefined];
      return waitForSelector(selector, timeoutMs ?? 5000);
    }

    case "getUrl": {
      return getUrl();
    }

    case "getSelection": {
      return getSelection();
    }

    case "domDigest": {
      return domDigest();
    }

    case "readPage": {
      return readPage();
    }

    default: {
      const _exhaustive: never = op;
      void _exhaustive;
      return { ok: false, error: `Unknown op: ${op}` };
    }
  }
}

// ---------------------------------------------------------------------------
// Expose domDigest globally so the agent-loop can call it via
// chrome.scripting.executeScript for out-of-band page context fetches.
// ---------------------------------------------------------------------------
(globalThis as Record<string, unknown>).__fba_domDigest = domDigest;
(globalThis as Record<string, unknown>).__fba_readPage = readPage;
