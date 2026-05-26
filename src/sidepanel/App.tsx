/**
 * src/sidepanel/App.tsx
 *
 * Full Preact chat UI for the Free Browser Agent side panel.
 * - Message list with user / assistant / tool / system roles
 * - Streaming text render with typing cursor
 * - Inline tool-call display (collapsible, shows args + result)
 * - X-Routed-Via badge on assistant messages
 * - Sends {kind:"agent:start"} to background, listens for AgentStatus
 */

import { h, Fragment, render } from "preact";
import { useEffect, useRef, useState, useCallback } from "preact/hooks";
import "./styles.css";
import type { AgentStatus, AssistantMessage, ToolCall } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Local UI message shape
// ---------------------------------------------------------------------------

interface UiMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  streaming?: boolean;
  routedVia?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: string;
  toolOk?: boolean;
}

let _idCounter = 0;
function uid(): string {
  return "m-" + Date.now() + "-" + ++_idCounter;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function RoutingBadge({ via }: { via: string }) {
  return (
    <span class="routing-badge">
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
      </svg>
      {via}
    </span>
  );
}

function Spinner() {
  return (
    <svg
      class="animate-spin h-3 w-3 text-brand-400 inline-block"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        class="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        stroke-width="4"
      />
      <path
        class="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
      />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <rect x="4" y="4" width="16" height="16" rx="2" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// ToolCallBubble
// ---------------------------------------------------------------------------

interface ToolCallBubbleProps {
  toolName: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: string;
  toolOk?: boolean;
}

function ToolCallBubble({ toolName, toolArgs, toolResult, toolOk }: ToolCallBubbleProps) {
  const [expanded, setExpanded] = useState(false);
  const pending = toolResult === undefined;
  const argPreview = toolArgs
    ? Object.entries(toolArgs)
        .slice(0, 2)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(", ")
    : "";

  return (
    <div class="msg-tool">
      <button
        class="w-full text-left flex items-center gap-2 focus:outline-none"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
      >
        {pending ? (
          <Spinner />
        ) : toolOk ? (
          <span class="text-green-400">✓</span>
        ) : (
          <span class="text-red-400">✗</span>
        )}
        <span class="text-brand-400 font-semibold">{toolName}</span>
        {argPreview && (
          <span class="text-gray-500 truncate text-[10px]">({argPreview})</span>
        )}
        <span class="ml-auto text-gray-600 text-[10px]">{expanded ? "▲" : "▼"}</span>
      </button>

      {expanded && (
        <div class="mt-2 space-y-1">
          {toolArgs && (
            <div>
              <div class="text-gray-500 text-[10px] uppercase tracking-wide mb-0.5">args</div>
              <pre class="text-gray-300 text-[10px] overflow-auto max-h-24 whitespace-pre-wrap">
                {JSON.stringify(toolArgs, null, 2)}
              </pre>
            </div>
          )}
          {toolResult !== undefined && (
            <div>
              <div class="text-gray-500 text-[10px] uppercase tracking-wide mb-0.5">result</div>
              <pre class="text-gray-300 text-[10px] overflow-auto max-h-24 whitespace-pre-wrap">
                {toolResult}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MessageBubble
// ---------------------------------------------------------------------------

function MessageBubble({ msg }: { msg: UiMessage }) {
  if (msg.role === "system") {
    return <div class="msg-system-note">{msg.text}</div>;
  }

  if (msg.role === "tool") {
    return (
      <ToolCallBubble
        toolName={msg.toolName ?? "tool"}
        toolArgs={msg.toolArgs}
        toolResult={msg.toolResult}
        toolOk={msg.toolOk}
      />
    );
  }

  if (msg.role === "user") {
    return (
      <div class="msg-user">
        {msg.text}
      </div>
    );
  }

  // assistant
  return (
    <div class="flex flex-col items-start gap-1 max-w-[85%]">
      <div class={`msg-assistant${msg.streaming ? " typing-cursor" : ""}`}>
        {msg.text || (msg.streaming ? "" : "…")}
      </div>
      {msg.routedVia && <RoutingBadge via={msg.routedVia} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AgentPhaseIndicator
// ---------------------------------------------------------------------------

function AgentPhaseIndicator({
  phase,
  iteration,
}: {
  phase: string;
  iteration?: number;
}) {
  const labels: Record<string, string> = {
    thinking: "Thinking…",
    calling: "Calling tool…",
    streaming: "Streaming…",
    done: "Done",
    error: "Error",
  };
  return (
    <div class="flex items-center gap-2 text-xs text-gray-500 py-1 px-2">
      {phase !== "done" && phase !== "error" && <Spinner />}
      <span>{labels[phase] ?? phase}</span>
      {iteration !== undefined && iteration > 1 && (
        <span class="text-gray-600">· step {iteration}</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function Header({
  onOpenSettings,
  onStopAgent,
  agentRunning,
}: {
  onOpenSettings: () => void;
  onStopAgent: () => void;
  agentRunning: boolean;
}) {
  return (
    <header class="flex items-center gap-2 px-3 py-2 border-b border-gray-800/60 bg-gray-950/80 backdrop-blur-sm flex-shrink-0">
      <div class="flex items-center gap-2 flex-1 min-w-0">
        <div class="w-5 h-5 rounded-md bg-brand-600 flex items-center justify-center flex-shrink-0">
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="currentColor"
            class="text-white"
            aria-hidden="true"
          >
            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
          </svg>
        </div>
        <span class="text-sm font-semibold text-gray-100 truncate">Free Browser Agent</span>
      </div>

      <div class="flex items-center gap-1">
        {agentRunning && (
          <button
            class="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-red-400 hover:bg-red-900/30 transition-colors focus-ring"
            onClick={onStopAgent}
            title="Stop agent"
          >
            <StopIcon />
            Stop
          </button>
        )}
        <button
          class="p-1.5 rounded-md text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors focus-ring"
          onClick={onOpenSettings}
          title="Settings"
          aria-label="Open settings"
        >
          <GearIcon />
        </button>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// InputArea
// ---------------------------------------------------------------------------

function InputArea({
  onSend,
  disabled,
}: {
  onSend: (text: string) => void;
  disabled: boolean;
}) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 160) + "px";
  }, [value]);

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const submit = () => {
    const text = value.trim();
    if (!text || disabled) return;
    onSend(text);
    setValue("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  return (
    <div class="flex-shrink-0 border-t border-gray-800/60 bg-gray-950/80 backdrop-blur-sm p-2">
      <div class="flex items-end gap-2 bg-gray-900 rounded-xl px-3 py-2 border border-gray-700/50 focus-within:border-brand-600/60 transition-colors">
        <textarea
          ref={textareaRef}
          class="flex-1 bg-transparent text-sm text-gray-100 placeholder-gray-600 resize-none outline-none min-h-[24px] max-h-[160px] leading-relaxed"
          placeholder={disabled ? "Agent is running…" : "Ask the agent to do something…"}
          value={value}
          onInput={(e) => setValue((e.target as HTMLTextAreaElement).value)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          rows={1}
          aria-label="Message input"
        />
        <button
          class={`flex-shrink-0 p-1.5 rounded-lg transition-all focus-ring ${
            value.trim() && !disabled
              ? "text-white bg-brand-600 hover:bg-brand-500"
              : "text-gray-600 cursor-not-allowed"
          }`}
          onClick={submit}
          disabled={!value.trim() || disabled}
          aria-label="Send message"
        >
          <SendIcon />
        </button>
      </div>
      <p class="text-[10px] text-gray-700 mt-1 px-1">
        Enter to send · Shift+Enter for newline
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// WelcomeScreen
// ---------------------------------------------------------------------------

const EXAMPLE_PROMPTS = [
  "Summarize the main content of this page",
  "Fill out the contact form with my details",
  "Find all links on this page and list them",
  "Click the sign-in button and log me in",
];

function WelcomeScreen({ onSend }: { onSend: (text: string) => void }) {
  return (
    <div class="flex flex-col items-center justify-center h-full px-4 gap-6">
      <div class="text-center">
        <div class="w-12 h-12 rounded-2xl bg-brand-600/20 border border-brand-600/30 flex items-center justify-center mx-auto mb-3">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            class="text-brand-400"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4l3 3" />
          </svg>
        </div>
        <h2 class="text-sm font-semibold text-gray-200 mb-1">Free Browser Agent</h2>
        <p class="text-xs text-gray-500 max-w-[200px]">
          Tell me what to do on this page and I will handle it.
        </p>
      </div>

      <div class="w-full space-y-2">
        {EXAMPLE_PROMPTS.map((p) => (
          <button
            key={p}
            class="w-full text-left text-xs text-gray-400 px-3 py-2 rounded-lg bg-gray-900/60 border border-gray-800/60 hover:border-brand-700/40 hover:text-gray-300 hover:bg-gray-900 transition-all focus-ring"
            onClick={() => onSend(p)}
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// App (main component)
// ---------------------------------------------------------------------------

export default function App() {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [agentRunning, setAgentRunning] = useState(false);
  const [agentPhase, setAgentPhase] = useState<string>("idle");
  const [agentIteration, setAgentIteration] = useState<number | undefined>(undefined);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom on new messages
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Dark mode class
  useEffect(() => {
    document.documentElement.classList.add("dark");
  }, []);

  // Listen for messages from background service worker
  useEffect(() => {
      // We accept any message from the background — AgentStatus plus
    // extension-internal kinds (agent:delta, agent:message, etc.)
    const listener = (msg: unknown) => {
      if (!msg || typeof msg !== "object") return;
      const m = msg as Record<string, unknown>;
      if (!m.kind) return;

      if (m.kind === "agent:status") {
        const status = m as AgentStatus & Record<string, unknown>;
        setAgentPhase(status.phase as string);

        if (status.phase === "thinking") {
          setAgentIteration((status as { phase: "thinking"; iteration: number }).iteration);
        } else {
          setAgentIteration(undefined);
        }

        if (status.phase === "done" || status.phase === "error" || status.phase === "max_iterations") {
          setAgentRunning(false);

          // Finalize last streaming message when done
          if (status.phase === "done") {
            const doneMsg = status as AgentStatus & { phase: "done"; message: AssistantMessage };
            setMessages((prev) => {
              const idx = prev.findIndex((p) => p.streaming && p.role === "assistant");
              const finalMsg: UiMessage = {
                id: uid(),
                role: "assistant",
                text: doneMsg.message.content ?? "",
                streaming: false,
                routedVia: doneMsg.message._routed_via,
              };
              if (idx !== -1) {
                const updated = [...prev];
                updated[idx] = { ...updated[idx], ...finalMsg, streaming: false };
                return updated;
              }
              // Only add if there is actual content
              if (finalMsg.text) return [...prev, finalMsg];
              return prev;
            });
          }

          if (status.phase === "error") {
            const errStatus = status as AgentStatus & { phase: "error"; error: string };
            setErrorBanner(errStatus.error);
          }
        }
        return;
      }

      // agent:delta — streaming text chunk
      if (m.kind === "agent:delta") {
        const delta = m as { id: string; text: string; routedVia?: string };
        setMessages((prev) => {
          const idx = prev.findIndex((p) => p.id === delta.id);
          if (idx === -1) {
            return [
              ...prev,
              {
                id: delta.id,
                role: "assistant" as const,
                text: delta.text,
                streaming: true,
                routedVia: delta.routedVia,
              },
            ];
          }
          const updated = [...prev];
          updated[idx] = {
            ...updated[idx],
            text: delta.text,
            routedVia: delta.routedVia ?? updated[idx].routedVia,
            streaming: true,
          };
          return updated;
        });
        return;
      }

      // agent:tool-start — new tool call beginning
      if (m.kind === "agent:tool-start") {
        const ts = m as { callId: string; name: string; args: Record<string, unknown> };
        setMessages((prev) => [
          ...prev,
          {
            id: ts.callId,
            role: "tool" as const,
            text: "",
            toolName: ts.name,
            toolArgs: ts.args,
            toolOk: undefined,
          },
        ]);
        return;
      }

      // agent:tool-done — tool call result arrived
      if (m.kind === "agent:tool-done") {
        const td = m as { callId: string; result: string; ok: boolean };
        setMessages((prev) => {
          const idx = prev.findIndex((p) => p.id === td.callId && p.role === "tool");
          if (idx === -1) return prev;
          const updated = [...prev];
          updated[idx] = { ...updated[idx], toolResult: td.result, toolOk: td.ok };
          return updated;
        });
        return;
      }
    };

    chrome.runtime.onMessage.addListener(listener as Parameters<typeof chrome.runtime.onMessage.addListener>[0]);
    return () => {
      chrome.runtime.onMessage.removeListener(listener as Parameters<typeof chrome.runtime.onMessage.removeListener>[0]);
    };
  }, []);

  const handleSend = useCallback(async (text: string) => {
    setErrorBanner(null);

    // Add user message
    setMessages((prev) => [
      ...prev,
      { id: uid(), role: "user", text },
    ]);

    setAgentRunning(true);
    setAgentPhase("thinking");

    try {
      // Get active tab
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        throw new Error("No active tab found");
      }

      chrome.runtime.sendMessage({
        kind: "agent:start",
        tabId: tab.id,
        messages: [{ role: "user", content: text }],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setErrorBanner(message);
      setAgentRunning(false);
      setAgentPhase("idle");
    }
  }, []);

  const handleStop = useCallback(async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      chrome.runtime.sendMessage({ kind: "agent:stop", tabId: tab?.id });
    } catch {
      // ignore
    }
    setAgentRunning(false);
    setAgentPhase("idle");
  }, []);

  const handleOpenSettings = useCallback(() => {
    chrome.runtime.openOptionsPage();
  }, []);

  const showWelcome = messages.length === 0 && !agentRunning;

  return (
    <div class="flex flex-col h-full bg-gray-950 text-gray-100">
      <Header
        onOpenSettings={handleOpenSettings}
        onStopAgent={handleStop}
        agentRunning={agentRunning}
      />

      {/* Error banner */}
      {errorBanner && (
        <div class="flex items-center gap-2 px-3 py-2 bg-red-900/30 border-b border-red-800/40 text-xs text-red-300 flex-shrink-0">
          <span class="flex-1">{errorBanner}</span>
          <button
            class="text-red-400 hover:text-red-200 transition-colors"
            onClick={() => setErrorBanner(null)}
            aria-label="Dismiss error"
          >
            ✕
          </button>
        </div>
      )}

      {/* Message area */}
      <div
        ref={scrollRef}
        class="flex-1 overflow-y-auto px-3 py-4"
      >
        {showWelcome ? (
          <WelcomeScreen onSend={handleSend} />
        ) : (
          <div class="flex flex-col gap-3">
            {messages.map((msg) => (
              <MessageBubble key={msg.id} msg={msg} />
            ))}
            {agentRunning && agentPhase !== "idle" && (
              <AgentPhaseIndicator phase={agentPhase} iteration={agentIteration} />
            )}
          </div>
        )}
      </div>

      <InputArea onSend={handleSend} disabled={agentRunning} />
    </div>
  );
}

const root = document.getElementById("root");
if (root) render(h(App, {}), root);
