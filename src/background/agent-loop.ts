/**
 * Agent Loop — LLM ↔ tool-call cycle
 *
 * Each iteration:
 *  1. Call router.chatCompletion(messages, tools)
 *  2. If the response has tool_calls[], dispatch each one:
 *     - DOM ops → chrome.tabs.sendMessage(tabId, {kind:"dom-op", payload:{op, ...args}})
 *     - screenshot / cdp-escalation → cdp.ts helpers
 *  3. Append tool results as {role:"tool", tool_call_id, content} messages
 *  4. Loop until assistant sends a message with no tool_calls, or max
 *     iterations is reached.
 *
 * Status callbacks are emitted per-iteration so the side panel can show
 * live progress without polling.
 */

import * as cdp from "./cdp.js";
import type { ChatMessage, ToolCall, AssistantMessage } from "../shared/types.js";
import type { Tool } from "../shared/tools.js";
import type { DomOpResult } from "../shared/messages.js";

// ── Router interface ──────────────────────────────────────────────────────────

/** Minimal router interface — matches src/router.ts */
export interface Router {
  chatCompletion(
    messages: ChatMessage[],
    tools?: Tool[]
  ): Promise<{
    message: AssistantMessage;
    providerUsed: string;
  }>;
}

// ── Agent status ──────────────────────────────────────────────────────────────

/** Progress update emitted each iteration */
export interface AgentLoopStatus {
  iter: number;
  action: string;
  providerUsed?: string;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const MAX_ITERATIONS = 20;

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Send a DOM operation to the content script.
 * The content script listens for {kind:"dom-op", payload} messages.
 */
async function sendDomOp(
  tabId: number,
  op: string,
  args: Record<string, unknown>
): Promise<DomOpResult> {
  try {
    const response = (await chrome.tabs.sendMessage(tabId, {
      kind: "dom-op",
      // payload is the DomOpArgs discriminated union
      payload: { op, ...args },
    })) as DomOpResult | undefined;

    if (response == null) {
      return { ok: false, error: "No response from content script (not injected?)" };
    }
    return response;
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Dispatch a single tool call.
 * Returns the string content to feed back to the LLM as a tool result.
 */
async function dispatchToolCall(
  toolCall: ToolCall,
  tabId: number
): Promise<string> {
  const { name, arguments: rawArgs } = toolCall.function;

  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(rawArgs) as Record<string, unknown>;
  } catch {
    return JSON.stringify({ ok: false, error: "Invalid JSON in tool arguments" });
  }

  // ── screenshot (always via CDP) ────────────────────────────────────────────
  if (name === "screenshot") {
    try {
      const { data } = await cdp.screenshot(tabId);
      return JSON.stringify({
        ok: true,
        data_uri: `data:image/png;base64,${data}`,
      });
    } catch (err) {
      return JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── DOM operations — try content script first, escalate to CDP ────────────
  const DOM_OPS = new Set([
    "click",
    "type",
    "fillForm",
    "scroll",
    "readPage",
    "waitForSelector",
    "getUrl",
    "getSelection",
  ]);

  if (DOM_OPS.has(name)) {
    const result = await sendDomOp(tabId, name, args);

    if (!result.ok && result.escalate === "cdp") {
      // CDP escalation path
      try {
        if (name === "click") {
          // For CDP click we need coordinates. Try to get them via the selector
          // using a quick eval — if that fails, return the error.
          const selector = String(args.selector ?? "");
          const coordResult = (await chrome.tabs.sendMessage(tabId, {
            kind: "dom-op",
            payload: { op: "getElementCoords", selector },
          })) as { ok: boolean; x?: number; y?: number; error?: string } | undefined;

          if (coordResult?.ok && coordResult.x != null && coordResult.y != null) {
            await cdp.dispatchClick(tabId, coordResult.x, coordResult.y);
            return JSON.stringify({ ok: true, result: "cdp-click dispatched" });
          } else {
            return JSON.stringify({
              ok: false,
              error: `CDP escalation: could not resolve coordinates for selector "${selector}"`,
            });
          }
        }

        if (name === "type") {
          const text = String(args.text ?? "");
          await cdp.typeText(tabId, text);
          return JSON.stringify({ ok: true, result: "cdp-type dispatched" });
        }

        // Unhandled escalation — surface the original error
        return JSON.stringify({
          ok: false,
          error: `CDP escalation not implemented for op "${name}": ${result.error ?? "unknown"}`,
        });
      } catch (cdpErr) {
        return JSON.stringify({
          ok: false,
          error: `CDP escalation failed for op "${name}": ${
            cdpErr instanceof Error ? cdpErr.message : String(cdpErr)
          }`,
        });
      }
    }

    // Successful content-script result or non-CDP error
    return JSON.stringify(result);
  }

  // ── Unknown tool ───────────────────────────────────────────────────────────
  return JSON.stringify({ ok: false, error: `Unknown tool: ${name}` });
}

// ── Main export ────────────────────────────────────────────────────────────────

/**
 * Run the agent loop until the LLM produces a final answer (no tool_calls)
 * or the iteration cap is reached.
 *
 * @param args.messages   Conversation history (mutated in-place)
 * @param args.tools      Tool definitions visible to the LLM
 * @param args.tabId      Active Chrome tab ID for DOM operations
 * @param args.router     LLM router instance
 * @param args.onStatus   Callback invoked with progress updates each iteration
 * @returns               The final assistant ChatMessage
 */
export async function runAgentLoop(args: {
  messages: ChatMessage[];
  tools: Tool[];
  tabId: number;
  router: Router;
  onStatus: (status: AgentLoopStatus) => void;
}): Promise<AssistantMessage> {
  const { messages, tools, tabId, onStatus, router } = args;

  let lastAssistantMessage: AssistantMessage = {
    role: "assistant",
    content: "Agent loop did not produce a response.",
  };

  for (let iter = 1; iter <= MAX_ITERATIONS; iter++) {
    // ── Call the LLM ──────────────────────────────────────────────────────────
    let providerUsed = "unknown";
    let assistantMessage: AssistantMessage;

    try {
      const response = await router.chatCompletion(messages, tools);
      assistantMessage = response.message;
      providerUsed = response.providerUsed;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      onStatus({ iter, action: `LLM error: ${errMsg}`, providerUsed: "error" });

      lastAssistantMessage = {
        role: "assistant",
        content: `I encountered an error while processing your request: ${errMsg}`,
      };
      messages.push(lastAssistantMessage);
      return lastAssistantMessage;
    }

    messages.push(assistantMessage);
    lastAssistantMessage = assistantMessage;

    // ── No tool calls → final answer ──────────────────────────────────────────
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      onStatus({ iter, action: "final answer", providerUsed });
      return assistantMessage;
    }

    // ── Dispatch tool calls ───────────────────────────────────────────────────
    const toolCallSummary = assistantMessage.tool_calls
      .map((tc) => tc.function.name)
      .join(", ");

    onStatus({
      iter,
      action: `calling tools: ${toolCallSummary}`,
      providerUsed,
    });

    // Execute tool calls sequentially (DOM ops must be serialised to avoid
    // race conditions on the page)
    for (const toolCall of assistantMessage.tool_calls) {
      const content = await dispatchToolCall(toolCall, tabId);
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content,
      });
    }
  }

  // ── Iteration cap reached ─────────────────────────────────────────────────
  onStatus({
    iter: MAX_ITERATIONS,
    action: "iteration cap reached",
    providerUsed: "n/a",
  });

  // Append a synthetic summary if the last message wasn't a clean final answer
  if (lastAssistantMessage.tool_calls?.length) {
    lastAssistantMessage = {
      role: "assistant",
      content:
        "I reached the maximum number of steps without completing the task. " +
        "Please try rephrasing your request or break it into smaller steps.",
    };
    messages.push(lastAssistantMessage);
  }

  return lastAssistantMessage;
}
