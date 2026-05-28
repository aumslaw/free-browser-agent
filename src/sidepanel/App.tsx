/**
 * src/sidepanel/App.tsx
 *
 * Full Preact chat UI for the Free Browser Agent side panel.
 * - Message list with user / assistant / tool / system roles
 * - Streaming text render with typing cursor
 * - Markdown rendering for assistant replies (code blocks, lists, links)
 * - Conversation history: persisted to chrome.storage.local, sidebar + new-chat + switch/delete
 * - Multi-turn: prior user/assistant turns are sent to the agent for context
 * - Inline tool-call display (collapsible, shows args + result)
 * - X-Routed-Via badge on assistant messages
 * - Sends {kind:"agent:start"} to background, listens for AgentStatus
 */

import { h, render } from "preact";
import { useEffect, useRef, useState, useCallback } from "preact/hooks";
import "./styles.css";
import type { AgentStatus, AssistantMessage } from "../shared/types.js";
import { Markdown } from "./Markdown.js";
import {
  type ConversationMeta,
  listConversations,
  getConversation,
  saveConversation,
  deleteConversation,
  createConversation,
  deriveTitle,
  getLastActiveId,
  setLastActiveId,
} from "./lib/history.js";
import { useSpeechRecognition } from "./lib/speech.js";
import { type Attachment, readFileAsAttachment, buildUserContent } from "./lib/attachments.js";

// ---------------------------------------------------------------------------
// Local UI message shape (structurally compatible with StoredMessage)
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

function relTime(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const hr = Math.floor(m / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function RoutingBadge({ via }: { via: string }) {
  return (
    <span class="routing-badge">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
      </svg>
      {via}
    </span>
  );
}

function Spinner() {
  return (
    <svg class="animate-spin h-3 w-3 text-brand-400 inline-block" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
      <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="4" y="4" width="16" height="16" rx="2" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="9" y="2" width="6" height="11" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <line x1="12" y1="19" x2="12" y2="22" />
      <line x1="8" y1="22" x2="16" y2="22" />
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function PaperclipIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
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
    ? Object.entries(toolArgs).slice(0, 2).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ")
    : "";

  return (
    <div class="msg-tool">
      <button class="w-full text-left flex items-center gap-2 focus:outline-none" onClick={() => setExpanded((e) => !e)} aria-expanded={expanded}>
        {pending ? <Spinner /> : toolOk ? <span class="text-green-400">✓</span> : <span class="text-red-400">✗</span>}
        <span class="text-brand-400 font-semibold">{toolName}</span>
        {argPreview && <span class="text-gray-500 truncate text-[10px]">({argPreview})</span>}
        <span class="ml-auto text-gray-600 text-[10px]">{expanded ? "▲" : "▼"}</span>
      </button>
      {expanded && (
        <div class="mt-2 space-y-1">
          {toolArgs && (
            <div>
              <div class="text-gray-500 text-[10px] uppercase tracking-wide mb-0.5">args</div>
              <pre class="text-gray-300 text-[10px] overflow-auto max-h-24 whitespace-pre-wrap">{JSON.stringify(toolArgs, null, 2)}</pre>
            </div>
          )}
          {toolResult !== undefined && (
            <div>
              <div class="text-gray-500 text-[10px] uppercase tracking-wide mb-0.5">result</div>
              <pre class="text-gray-300 text-[10px] overflow-auto max-h-24 whitespace-pre-wrap">{toolResult}</pre>
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
    return <ToolCallBubble toolName={msg.toolName ?? "tool"} toolArgs={msg.toolArgs} toolResult={msg.toolResult} toolOk={msg.toolOk} />;
  }
  if (msg.role === "user") {
    return <div class="msg-user">{msg.text}</div>;
  }
  // assistant — markdown-rendered, with a typing cursor while streaming
  return (
    <div class="flex flex-col items-start gap-1 max-w-[85%]">
      <div data-testid="assistant-msg" class={`msg-assistant${msg.streaming ? " typing-cursor" : ""}`}>
        {msg.text ? (
          <div data-testid="assistant-text"><Markdown source={msg.text} /></div>
        ) : msg.streaming ? "" : "…"}
      </div>
      {msg.routedVia && <RoutingBadge via={msg.routedVia} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AgentPhaseIndicator
// ---------------------------------------------------------------------------

function AgentPhaseIndicator({ phase, iteration }: { phase: string; iteration?: number }) {
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
      {iteration !== undefined && iteration > 1 && <span class="text-gray-600">· step {iteration}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function Header({
  onOpenSettings,
  onStopAgent,
  onToggleHistory,
  onNewChat,
  agentRunning,
}: {
  onOpenSettings: () => void;
  onStopAgent: () => void;
  onToggleHistory: () => void;
  onNewChat: () => void;
  agentRunning: boolean;
}) {
  return (
    <header class="flex items-center gap-2 px-3 py-2 border-b border-gray-800/60 bg-gray-950/80 backdrop-blur-sm flex-shrink-0">
      <button
        data-testid="history-toggle"
        class="p-1.5 rounded-md text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors focus-ring"
        onClick={onToggleHistory}
        title="Conversation history"
        aria-label="Conversation history"
      >
        <MenuIcon />
      </button>
      <div class="flex items-center gap-2 flex-1 min-w-0">
        <div class="w-5 h-5 rounded-md bg-brand-600 flex items-center justify-center flex-shrink-0">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" class="text-white" aria-hidden="true">
            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
          </svg>
        </div>
        <span class="text-sm font-semibold text-gray-100 truncate">Free Browser Agent</span>
      </div>
      <div class="flex items-center gap-1">
        {agentRunning && (
          <button class="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-red-400 hover:bg-red-900/30 transition-colors focus-ring" onClick={onStopAgent} title="Stop agent">
            <StopIcon />
            Stop
          </button>
        )}
        <button data-testid="new-chat-header" class="p-1.5 rounded-md text-gray-400 hover:text-brand-400 hover:bg-gray-800 transition-colors focus-ring" onClick={onNewChat} title="New chat" aria-label="New chat">
          <PlusIcon />
        </button>
        <button class="p-1.5 rounded-md text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors focus-ring" onClick={onOpenSettings} title="Settings" aria-label="Open settings">
          <GearIcon />
        </button>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// HistorySidebar
// ---------------------------------------------------------------------------

function HistorySidebar({
  open,
  conversations,
  activeId,
  onClose,
  onSelect,
  onDelete,
  onNew,
}: {
  open: boolean;
  conversations: ConversationMeta[];
  activeId: string | null;
  onClose: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
}) {
  if (!open) return null;
  return (
    <div class="absolute inset-0 z-20 flex">
      <div class="w-72 max-w-[80%] h-full bg-gray-900 border-r border-gray-800 flex flex-col shadow-2xl">
        <div class="flex items-center justify-between px-3 py-2.5 border-b border-gray-800">
          <span class="text-xs font-semibold text-gray-300 tracking-wide">History</span>
          <button onClick={onClose} title="Close" class="p-1 rounded text-gray-500 hover:text-gray-300 hover:bg-gray-800 transition-colors focus-ring">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <button data-testid="new-chat" onClick={onNew} class="m-2 flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium bg-brand-600 text-white hover:bg-brand-500 active:scale-[0.98] transition-all focus-ring">
          <PlusIcon />
          New chat
        </button>
        <div class="flex-1 overflow-y-auto px-2 pb-2 flex flex-col gap-0.5">
          {conversations.length === 0 ? (
            <p class="text-xs text-gray-600 text-center mt-4">No conversations yet</p>
          ) : (
            conversations.map((c) => (
              <div
                key={c.id}
                data-testid="conversation-item"
                onClick={() => onSelect(c.id)}
                class={"group flex items-center gap-2 px-2.5 py-2 rounded-lg cursor-pointer transition-colors " + (c.id === activeId ? "bg-brand-600/15 border border-brand-600/30" : "hover:bg-gray-800 border border-transparent")}
              >
                <div class="flex-1 min-w-0">
                  <p class="text-xs text-gray-200 truncate m-0">{c.title}</p>
                  <p class="text-[10px] text-gray-500 m-0">{relTime(c.updatedAt)}</p>
                </div>
                <button onClick={(e) => { e.stopPropagation(); onDelete(c.id); }} title="Delete conversation" class="opacity-0 group-hover:opacity-100 p-1 rounded text-gray-500 hover:text-red-400 hover:bg-gray-800 transition-all">
                  <TrashIcon />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
      <div class="flex-1 h-full bg-black/50" onClick={onClose} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// InputArea
// ---------------------------------------------------------------------------

function InputArea({ onSend, disabled }: { onSend: (text: string, attachments?: Attachment[]) => void; disabled: boolean }) {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const speech = useSpeechRecognition((text) => setValue((v) => (v ? v + " " : "") + text));

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 160) + "px";
  }, [value]);

  const addFiles = async (files: FileList | File[]) => {
    const fileArray = Array.from(files);
    const read = await Promise.all(fileArray.map(readFileAsAttachment));
    setAttachments((prev) => [...prev, ...read]);
  };

  const removeAttachment = (idx: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  };

  const submit = () => {
    const text = value.trim();
    if (!text || disabled) return;
    onSend(text, attachments.length > 0 ? attachments : undefined);
    setValue("");
    setAttachments([]);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const handleMic = () => {
    if (speech.listening) {
      speech.stop();
    } else {
      speech.start();
    }
  };

  const handleAttachClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: Event) => {
    const input = e.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      void addFiles(input.files);
      // Reset so the same file can be re-attached if removed.
      input.value = "";
    }
  };

  const handlePaste = (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault();
      void addFiles(imageFiles);
    }
  };

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
      void addFiles(e.dataTransfer.files);
    }
  };

  return (
    <div
      class="flex-shrink-0 border-t border-gray-800/60 bg-gray-950/80 backdrop-blur-sm p-2"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,.txt,.md,.json,.csv,.pdf,text/*"
        class="hidden"
        aria-hidden="true"
        onChange={handleFileChange}
      />

      {/* Attachment chips */}
      {attachments.length > 0 && (
        <div class="flex flex-wrap gap-1 mb-1.5 px-1">
          {attachments.map((att, idx) => (
            <span
              key={`${att.name}-${idx}`}
              data-testid="attachment-chip"
              class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] bg-gray-800 border border-gray-700 text-gray-300"
            >
              <span class="max-w-[120px] truncate">{att.name}</span>
              <button
                type="button"
                class="text-gray-500 hover:text-red-400 transition-colors leading-none"
                onClick={() => removeAttachment(idx)}
                aria-label={`Remove ${att.name}`}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      <div class="flex items-end gap-2 bg-gray-900 rounded-xl px-3 py-2 border border-gray-700/50 focus-within:border-brand-600/60 transition-colors">
        {/* Paperclip attach button */}
        <button
          data-testid="attach"
          type="button"
          class="flex-shrink-0 p-1.5 rounded-lg text-gray-400 hover:text-brand-400 transition-all focus-ring"
          onClick={handleAttachClick}
          title="Attach file (image, text, PDF)"
          aria-label="Attach file"
          disabled={disabled}
        >
          <PaperclipIcon />
        </button>

        <textarea
          ref={textareaRef}
          class="flex-1 bg-transparent text-sm text-gray-100 placeholder-gray-600 resize-none outline-none min-h-[24px] max-h-[160px] leading-relaxed"
          placeholder={disabled ? "Agent is running…" : "Ask the agent to do something…"}
          value={value}
          onInput={(e) => setValue((e.target as HTMLTextAreaElement).value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          disabled={disabled}
          rows={1}
          aria-label="Message input"
        />
        {speech.supported && (
          <button
            data-testid="mic"
            class={`flex-shrink-0 p-1.5 rounded-lg transition-all focus-ring ${speech.listening ? "text-brand-400 animate-pulse" : "text-gray-400 hover:text-brand-400"}`}
            onClick={handleMic}
            title={speech.listening ? "Stop dictation" : "Start voice dictation"}
            aria-label={speech.listening ? "Stop voice dictation" : "Start voice dictation"}
            aria-pressed={speech.listening}
            type="button"
          >
            <MicIcon />
          </button>
        )}
        <button
          class={`flex-shrink-0 p-1.5 rounded-lg transition-all focus-ring ${(value.trim() || attachments.length > 0) && !disabled ? "text-white bg-brand-600 hover:bg-brand-500" : "text-gray-600 cursor-not-allowed"}`}
          onClick={submit}
          disabled={(!value.trim() && attachments.length === 0) || disabled}
          aria-label="Send message"
        >
          <SendIcon />
        </button>
      </div>
      <p class="text-[10px] text-gray-700 mt-1 px-1">Enter to send · Shift+Enter for newline · Drag & drop or paste images</p>
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
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="text-brand-400" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4l3 3" />
          </svg>
        </div>
        <h2 class="text-sm font-semibold text-gray-200 mb-1">Free Browser Agent</h2>
        <p class="text-xs text-gray-500 max-w-[200px]">Tell me what to do on this page and I will handle it.</p>
      </div>
      <div class="w-full space-y-2">
        {EXAMPLE_PROMPTS.map((p) => (
          <button key={p} class="w-full text-left text-xs text-gray-400 px-3 py-2 rounded-lg bg-gray-900/60 border border-gray-800/60 hover:border-brand-700/40 hover:text-gray-300 hover:bg-gray-900 transition-all focus-ring" onClick={() => onSend(p)}>
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
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // messagesRef mirrors `messages` so persist() never reads a stale closure.
  const messagesRef = useRef<UiMessage[]>([]);
  const convRef = useRef<{ id: string; createdAt: number } | null>(null);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // Scroll to bottom on new messages
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Dark mode class
  useEffect(() => { document.documentElement.classList.add("dark"); }, []);

  const refreshList = useCallback(async () => {
    setConversations(await listConversations());
  }, []);

  const persist = useCallback(async () => {
    const conv = convRef.current;
    if (!conv) return;
    // Strip the transient streaming flag so a reload never shows a stuck cursor.
    const msgs = messagesRef.current.map((m) => ({ ...m, streaming: false }));
    if (msgs.length === 0) return;
    await saveConversation({ id: conv.id, title: deriveTitle(msgs), createdAt: conv.createdAt, updatedAt: Date.now(), messages: msgs });
    await setLastActiveId(conv.id);
    await refreshList();
  }, [refreshList]);

  const loadConversation = useCallback((c: { id: string; createdAt: number; messages: UiMessage[] }) => {
    convRef.current = { id: c.id, createdAt: c.createdAt };
    const msgs = c.messages.map((m) => ({ ...m, streaming: false }));
    messagesRef.current = msgs;
    setMessages(msgs);
    void setLastActiveId(c.id);
  }, []);

  // Mount: load the last-active conversation (or create a fresh one) + the list.
  useEffect(() => {
    void (async () => {
      const lastId = await getLastActiveId();
      const existing = lastId ? await getConversation(lastId) : null;
      const conv = existing ?? (await createConversation());
      loadConversation(conv as { id: string; createdAt: number; messages: UiMessage[] });
      await refreshList();
    })();
  }, [loadConversation, refreshList]);

  // Persist on every turn boundary (agentRunning flips: true when a turn starts
  // → saves the user message; false when it ends → saves the final reply).
  useEffect(() => {
    if (convRef.current && messagesRef.current.length > 0) void persist();
  }, [agentRunning, persist]);

  // Listen for messages from background service worker
  useEffect(() => {
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
          if (status.phase === "done") {
            const doneMsg = status as AgentStatus & { phase: "done"; message: AssistantMessage };
            setMessages((prev) => {
              const idx = prev.findIndex((p) => p.streaming && p.role === "assistant");
              const finalMsg: UiMessage = { id: uid(), role: "assistant", text: doneMsg.message.content ?? "", streaming: false, routedVia: doneMsg.message._routed_via };
              if (idx !== -1) {
                const updated = [...prev];
                updated[idx] = { ...updated[idx], ...finalMsg, id: updated[idx].id, streaming: false };
                return updated;
              }
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

      if (m.kind === "agent:delta") {
        const delta = m as { id: string; text: string; routedVia?: string };
        setMessages((prev) => {
          const idx = prev.findIndex((p) => p.id === delta.id);
          if (idx === -1) {
            return [...prev, { id: delta.id, role: "assistant" as const, text: delta.text, streaming: true, routedVia: delta.routedVia }];
          }
          const updated = [...prev];
          updated[idx] = { ...updated[idx], text: delta.text, routedVia: delta.routedVia ?? updated[idx].routedVia, streaming: true };
          return updated;
        });
        return;
      }

      if (m.kind === "agent:tool-start") {
        const ts = m as { callId: string; name: string; args: Record<string, unknown> };
        setMessages((prev) => [...prev, { id: ts.callId, role: "tool" as const, text: "", toolName: ts.name, toolArgs: ts.args, toolOk: undefined }]);
        return;
      }

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
    return () => chrome.runtime.onMessage.removeListener(listener as Parameters<typeof chrome.runtime.onMessage.removeListener>[0]);
  }, []);

  const handleSend = useCallback(async (text: string, attachments?: Attachment[]) => {
    setErrorBanner(null);

    // Build the content for the new user turn (multimodal if images are attached).
    const atts = attachments ?? [];
    const newTurnContent = buildUserContent(text, atts);

    // Build multi-turn context from prior user/assistant turns (kept as stored
    // string shapes) + the new message with its (potentially multimodal) content.
    const history = messagesRef.current
      .filter((p) => (p.role === "user" || p.role === "assistant") && p.text)
      .map((p) => ({ role: p.role, content: p.text }));
    history.push({ role: "user", content: newTurnContent as string });

    // Display text in the UI bubble: prompt + chip names for attached files.
    const displayText = text + (atts.length > 0 ? "\n\n" + atts.map((a) => `📎 ${a.name}`).join("\n") : "");
    setMessages((prev) => [...prev, { id: uid(), role: "user", text: displayText }]);
    setAgentRunning(true);
    setAgentPhase("thinking");

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error("No active tab found");
      chrome.runtime.sendMessage({ kind: "agent:start", tabId: tab.id, messages: history });
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
    } catch { /* ignore */ }
    setAgentRunning(false);
    setAgentPhase("idle");
  }, []);

  const handleOpenSettings = useCallback(() => { chrome.runtime.openOptionsPage(); }, []);

  const newChat = useCallback(async () => {
    const conv = await createConversation();
    loadConversation(conv as { id: string; createdAt: number; messages: UiMessage[] });
    setErrorBanner(null);
    await refreshList();
    setHistoryOpen(false);
  }, [loadConversation, refreshList]);

  const openConversation = useCallback(async (id: string) => {
    const conv = await getConversation(id);
    if (conv) loadConversation(conv as { id: string; createdAt: number; messages: UiMessage[] });
    setHistoryOpen(false);
  }, [loadConversation]);

  const removeConversation = useCallback(async (id: string) => {
    await deleteConversation(id);
    await refreshList();
    if (convRef.current?.id === id) {
      const remaining = await listConversations();
      if (remaining.length > 0) {
        const next = await getConversation(remaining[0].id);
        if (next) loadConversation(next as { id: string; createdAt: number; messages: UiMessage[] });
      } else {
        const conv = await createConversation();
        loadConversation(conv as { id: string; createdAt: number; messages: UiMessage[] });
        await refreshList();
      }
    }
  }, [refreshList, loadConversation]);

  const showWelcome = messages.length === 0 && !agentRunning;

  return (
    <div class="relative flex flex-col h-full bg-gray-950 text-gray-100">
      <HistorySidebar
        open={historyOpen}
        conversations={conversations}
        activeId={convRef.current?.id ?? null}
        onClose={() => setHistoryOpen(false)}
        onSelect={openConversation}
        onDelete={removeConversation}
        onNew={newChat}
      />

      <Header
        onOpenSettings={handleOpenSettings}
        onStopAgent={handleStop}
        onToggleHistory={() => setHistoryOpen(true)}
        onNewChat={newChat}
        agentRunning={agentRunning}
      />

      {errorBanner && (
        <div class="flex items-center gap-2 px-3 py-2 bg-red-900/30 border-b border-red-800/40 text-xs text-red-300 flex-shrink-0">
          <span class="flex-1">{errorBanner}</span>
          <button class="text-red-400 hover:text-red-200 transition-colors" onClick={() => setErrorBanner(null)} aria-label="Dismiss error">✕</button>
        </div>
      )}

      <div ref={scrollRef} class="flex-1 overflow-y-auto px-3 py-4">
        {showWelcome ? (
          <WelcomeScreen onSend={handleSend} />
        ) : (
          <div class="flex flex-col gap-3">
            {messages.map((msg) => (
              <MessageBubble key={msg.id} msg={msg} />
            ))}
            {agentRunning && agentPhase !== "idle" && <AgentPhaseIndicator phase={agentPhase} iteration={agentIteration} />}
          </div>
        )}
      </div>

      <InputArea onSend={handleSend as (text: string, attachments?: Attachment[]) => void} disabled={agentRunning} />
    </div>
  );
}

const root = document.getElementById("root");
if (root) render(h(App, {}), root);
