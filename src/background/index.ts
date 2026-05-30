/**
 * Background Service Worker — Extension entry point (MV3)
 *
 * Responsibilities:
 * 1. Open side panel when toolbar icon is clicked
 * 2. Route messages between side panel / content script / options page
 * 3. Host the agent loop — receives "agent:run" messages and drives
 *    runAgentLoop(), emitting "agent:status" and "agent:done" back to
 *    the side panel.
 *
 * Message protocol (runtime.onMessage):
 *
 *   → {kind:"agent:run", messages, tools, tabId}
 *       Starts the agent loop.  Replies: void (async status via runtime.sendMessage)
 *
 *   → {kind:"agent:status", iter, action, providerUsed}
 *       Forwarded from the loop to the side panel.
 *
 *   → {kind:"agent:done", message}
 *       Final assistant message forwarded to the side panel.
 *
 *   → {kind:"agent:error", error}
 *       Forwarded if the loop throws.
 *
 *   → {kind:"dom-op", op, args}
 *       Forwarded to the active tab's content script; response is the
 *       DomOpResult from dom-ops.ts.
 *
 *   → {kind:"options:open"}
 *       Opens the extension options page.
 *
 * Note: chrome.sidePanel is available from Chrome 114+.
 */

import { runAgentLoop } from "./agent-loop.js";
import type { Router, AgentLoopStatus } from "./agent-loop.js";
import type { ChatMessage } from "../shared/types.js";
import { AGENT_TOOLS } from "../shared/tools.js";
import { connectOpenRouter } from "../onboarding/openrouter-oauth.js";
import { autoProvision } from "../onboarding/auto-provision.js";

// ── Side Panel ─────────────────────────────────────────────────────────────

// Open the side panel when the user clicks the toolbar icon
chrome.action.onClicked.addListener((tab) => {
  if (tab.id == null) return;
  chrome.sidePanel
    .open({ windowId: tab.windowId })
    .catch((err: unknown) =>
      console.error("[SW] Failed to open side panel:", err)
    );
});

// ── Router singleton ───────────────────────────────────────────────────────
//
// The Router is imported lazily so that provider keys loaded from storage
// at runtime are used, not keys baked into the bundle.  We hold a singleton
// reference and re-create it when the options page saves new keys
// (via the "keys:updated" message).

let routerInstance: Router | null = null;

async function getRouter(): Promise<Router> {
  if (routerInstance) return routerInstance;
  // Dynamically import to avoid top-level await / circular dep issues
  const mod = await import("../router.js");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  routerInstance = new (mod as any).Router() as Router;
  return routerInstance;
}

function invalidateRouter(): void {
  routerInstance = null;
}

// ── Abort controllers per tab ──────────────────────────────────────────────
const abortControllers = new Map<number, AbortController>();

// ── Side panel port ────────────────────────────────────────────────────────

/** Track the port from the side panel for the current session */
let sidePanelPort: chrome.runtime.Port | null = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "sidepanel") {
    sidePanelPort = port;
    port.onDisconnect.addListener(() => {
      if (sidePanelPort === port) sidePanelPort = null;
    });
  }
});

/** Post a message to the side panel if it's connected */
function postToSidePanel(msg: Record<string, unknown>): void {
  if (sidePanelPort) {
    try {
      sidePanelPort.postMessage(msg);
    } catch {
      // Port disconnected between check and post — ignore
    }
    return;
  }
  // Fallback: broadcast via runtime message (side panel must listen)
  chrome.runtime.sendMessage(msg).catch(() => {
    // Ignore "no receivers" errors — side panel may not be open
  });
}

// ── Message Router ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (
    message: { kind: string } & Record<string, unknown>,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void
  ) => {
    const { kind } = message;

    // ── Start agent loop ─────────────────────────────────────────────────
    if (kind === "agent:start" || kind === "agent:run") {
      const { messages, tabId } = message as unknown as {
        messages: ChatMessage[];
        tabId: number;
      };

      abortControllers.get(tabId)?.abort();
      const ac = new AbortController();
      abortControllers.set(tabId, ac);

      void (async () => {
        try {
          const router = await getRouter();

          const onStatus = (s: AgentLoopStatus) => {
            if (ac.signal.aborted) return;
            postToSidePanel({ kind: "agent:status", tabId, iter: s.iter, action: s.action, providerUsed: s.providerUsed });
          };

          const finalMessage = await runAgentLoop({
            messages,
            tools: AGENT_TOOLS,
            tabId,
            router,
            onStatus,
          });

          if (!ac.signal.aborted) {
            postToSidePanel({ kind: "agent:status", phase: "done", tabId, message: finalMessage });
          }
        } catch (err) {
          if (!ac.signal.aborted) {
            const error = err instanceof Error ? err.message : String(err);
            // App.tsx's listener only handles {kind:"agent:status", phase:"error"}. Posting a
            // bare {kind:"agent:error"} (the prior shape) was silently dropped — leaving the side
            // panel stuck on "Thinking…" forever on ANY loop failure. Post the shape the UI reads.
            postToSidePanel({ kind: "agent:status", phase: "error", tabId, error });
          }
        } finally {
          abortControllers.delete(tabId);
        }
      })();

      sendResponse({ ok: true });
      return true;
    }

    // ── Stop agent loop ──────────────────────────────────────────────────
    if (kind === "agent:stop") {
      const { tabId } = message as unknown as { tabId: number };
      abortControllers.get(tabId)?.abort();
      abortControllers.delete(tabId);
      sendResponse({ ok: true });
      return;
    }

    // ── Forward dom-op to content script ────────────────────────────────
    if (kind === "dom-op") {
      const { payload, tabId } = message as unknown as {
        payload: Record<string, unknown>;
        tabId?: number;
      };

      void (async () => {
        // Resolve the active tab if tabId not specified
        let targetTabId = tabId;
        if (targetTabId == null) {
          const [activeTab] = await chrome.tabs.query({
            active: true,
            currentWindow: true,
          });
          targetTabId = activeTab?.id;
        }

        if (targetTabId == null) {
          sendResponse({ ok: false, error: "No active tab found" });
          return;
        }

        try {
          const response = await chrome.tabs.sendMessage(targetTabId, {
            kind: "dom-op",
            payload,
          });
          sendResponse(response);
        } catch (err) {
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();

      return true; // async response
    }

    // ── Open options page ────────────────────────────────────────────────
    if (kind === "options:open") {
      chrome.runtime.openOptionsPage();
      sendResponse({ ok: true });
      return;
    }

    // ── Invalidate router cache when keys change ─────────────────────────
    if (kind === "keys:updated") {
      invalidateRouter();
      sendResponse({ ok: true });
      return;
    }

    // ── Ping / health check ──────────────────────────────────────────────
    if (kind === "ping") {
      sendResponse({ ok: true, ts: Date.now() });
      return;
    }

    // ── OpenRouter OAuth onboarding ──────────────────────────────────────
    if (kind === "ONBOARD_OPENROUTER") {
      void (async () => {
        try {
          const result = await connectOpenRouter();
          sendResponse(result);
        } catch (err) {
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      })();
      return true; // async sendResponse
    }

    // ── Auto-provision onboarding ────────────────────────────────────────
    if (kind === "ONBOARD_AUTOPROVISION") {
      const { provider } = message as unknown as { provider: "google" | "groq" };
      void (async () => {
        try {
          const result = await autoProvision(provider);
          sendResponse(result);
        } catch (err) {
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      })();
      return true; // async sendResponse
    }

    // Unknown message — don't send a response (avoids "port closed" warnings)
  }
);

// ── Service-worker lifecycle ───────────────────────────────────────────────

// Keep the service worker alive while an agent loop is running by using
// the Offscreen Document API or a minimal alarm.  MV3 SWs idle after ~30s.
// We use a repeating alarm so the SW doesn't get killed mid-loop.

const KEEPALIVE_ALARM = "sw-keepalive";

chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    // No-op: just wakes the service worker
  }
});
