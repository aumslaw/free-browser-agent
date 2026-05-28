/**
 * src/options/App.tsx
 *
 * Settings page for Free Browser Agent.
 * - Provider API key management (add / delete per provider)
 * - Fallback chain reorder (up/down buttons)
 * - Test connection per saved key
 * - Live current-routing display
 */

import { h, Fragment, render, type ComponentChildren } from "preact";
import { useEffect, useState, useCallback } from "preact/hooks";
import type { ProviderId, StoredKey, ProviderPriorityList } from "../shared/types.js";
import { isChromeAIAvailable } from "../providers/chrome-ai.js";

// ---------------------------------------------------------------------------
// Styles (inline — options page loads independently of sidepanel)
// ---------------------------------------------------------------------------

const globalStyle = `
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #030712; color: #f3f4f6; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; font-size: 14px; }
  #root { max-width: 640px; margin: 0 auto; padding: 24px 16px 48px; }
  a { color: #818cf8; text-decoration: none; }
  a:hover { text-decoration: underline; }
`;

// ---------------------------------------------------------------------------
// Provider metadata
// ---------------------------------------------------------------------------

interface ProviderMeta {
  id: ProviderId;
  label: string;
  docsUrl: string;
  placeholder: string;
}

const PROVIDERS: ProviderMeta[] = [
  {
    id: "google",
    label: "Google Gemini",
    docsUrl: "https://aistudio.google.com/app/apikey",
    placeholder: "AIza…",
  },
  {
    id: "groq",
    label: "Groq",
    docsUrl: "https://console.groq.com/keys",
    placeholder: "gsk_…",
  },
  {
    id: "cerebras",
    label: "Cerebras",
    docsUrl: "https://cloud.cerebras.ai/",
    placeholder: "csk-…",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    docsUrl: "https://openrouter.ai/keys",
    placeholder: "sk-or-…",
  },
];

// ---------------------------------------------------------------------------
// OnboardingSection — 3 quick-start paths at the top of the page
// ---------------------------------------------------------------------------

function OnboardingSection() {
  const [orStatus, setOrStatus] = useState<string | null>(null);
  const [orWorking, setOrWorking] = useState(false);

  const [chromeAiStatus, setChromeAiStatus] = useState<string | null>(null);
  const [chromeAiWorking, setChromeAiWorking] = useState(false);

  const [apProvider, setApProvider] = useState<"google" | "groq">("google");
  const [apStatus, setApStatus] = useState<string | null>(null);
  const [apWorking, setApWorking] = useState(false);

  const handleOpenRouter = async () => {
    setOrWorking(true);
    setOrStatus(null);
    try {
      const result = await chrome.runtime.sendMessage({ kind: "ONBOARD_OPENROUTER" }) as
        | { ok: boolean; keyId?: string; error?: string }
        | undefined;
      if (result?.ok) {
        setOrStatus("Connected! Key saved (id: " + (result.keyId ?? "?") + ").");
      } else {
        setOrStatus("Error: " + (result?.error ?? "Unknown error"));
      }
    } catch (err) {
      setOrStatus("Error: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setOrWorking(false);
    }
  };

  const handleChromeAI = async () => {
    setChromeAiWorking(true);
    setChromeAiStatus(null);
    try {
      const available = await isChromeAIAvailable();
      if (available) {
        setChromeAiStatus(
          "Gemini Nano is available and ready — no login needed. " +
          "It is already first in your fallback chain.",
        );
      } else {
        setChromeAiStatus(
          "Gemini Nano is not available in this browser. " +
          "To enable it: open chrome://flags, search for 'Prompt API', enable it, " +
          "then restart Chrome. You may also need to go to chrome://components and " +
          "update 'Optimization Guide On Device Model'.",
        );
      }
    } catch (err) {
      setChromeAiStatus("Error checking availability: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setChromeAiWorking(false);
    }
  };

  const handleAutoProvision = async () => {
    setApWorking(true);
    setApStatus(null);
    try {
      const result = await chrome.runtime.sendMessage({
        kind: "ONBOARD_AUTOPROVISION",
        provider: apProvider,
      }) as { ok: boolean; keyId?: string; error?: string } | undefined;
      if (result?.ok) {
        setApStatus("Key provisioned for " + apProvider + "! Key id: " + (result.keyId ?? "?"));
      } else {
        setApStatus("Error: " + (result?.error ?? "Unknown error"));
      }
    } catch (err) {
      setApStatus("Error: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setApWorking(false);
    }
  };

  const btnBase: h.JSX.CSSProperties = {
    border: "none",
    borderRadius: "6px",
    padding: "8px 16px",
    fontSize: "13px",
    fontWeight: 600,
    cursor: "pointer",
    transition: "background 0.15s",
  };

  return (
    <section>
      <SectionTitle>Quick Start — Get Running in Seconds</SectionTitle>
      <p style={{ fontSize: "12px", color: "#6b7280", margin: "0 0 16px" }}>
        Pick one of the three paths below to connect a model. No setup required for Chrome AI.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>

        {/* Path 1 — OpenRouter OAuth */}
        <div style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: "10px", padding: "14px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "6px" }}>
            <span style={{ fontSize: "18px" }}>🔑</span>
            <span style={{ fontWeight: 600, color: "#e2e8f0", fontSize: "13px" }}>
              Sign in with OpenRouter
            </span>
            <span style={{ fontSize: "11px", color: "#6b7280" }}>
              — free account, 20+ models
            </span>
          </div>
          <p style={{ fontSize: "12px", color: "#9ca3af", margin: "0 0 10px" }}>
            Authenticates via OAuth. No key copy-paste needed.
          </p>
          <button
            onClick={handleOpenRouter}
            disabled={orWorking}
            style={{
              ...btnBase,
              background: orWorking ? "#374151" : "#7c3aed",
              color: orWorking ? "#6b7280" : "#fff",
              cursor: orWorking ? "not-allowed" : "pointer",
            }}
          >
            {orWorking ? "Connecting…" : "Sign in with OpenRouter"}
          </button>
          {orStatus && (
            <p style={{
              fontSize: "12px",
              color: orStatus.startsWith("Error") ? "#f87171" : "#4ade80",
              margin: "8px 0 0",
            }}>
              {orStatus}
            </p>
          )}
        </div>

        {/* Path 2 — Chrome built-in AI */}
        <div style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: "10px", padding: "14px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "6px" }}>
            <span style={{ fontSize: "18px" }}>🤖</span>
            <span style={{ fontWeight: 600, color: "#e2e8f0", fontSize: "13px" }}>
              Use Chrome built-in AI
            </span>
            <span style={{ fontSize: "11px", color: "#6b7280" }}>
              — Gemini Nano, on-device, no login
            </span>
          </div>
          <p style={{ fontSize: "12px", color: "#9ca3af", margin: "0 0 10px" }}>
            Runs 100% locally — no API key, no data leaves your device.
            Requires Chrome 127+ with the Prompt API flag enabled.
          </p>
          <button
            onClick={handleChromeAI}
            disabled={chromeAiWorking}
            style={{
              ...btnBase,
              background: chromeAiWorking ? "#374151" : "#059669",
              color: chromeAiWorking ? "#6b7280" : "#fff",
              cursor: chromeAiWorking ? "not-allowed" : "pointer",
            }}
          >
            {chromeAiWorking ? "Checking…" : "Check Chrome AI availability"}
          </button>
          {chromeAiStatus && (
            <p style={{
              fontSize: "12px",
              color: chromeAiStatus.startsWith("Gemini Nano is available") ? "#4ade80" : "#fbbf24",
              margin: "8px 0 0",
            }}>
              {chromeAiStatus}
            </p>
          )}
        </div>

        {/* Path 3 — Auto-provision */}
        <div style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: "10px", padding: "14px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "6px" }}>
            <span style={{ fontSize: "18px" }}>⚡</span>
            <span style={{ fontWeight: 600, color: "#e2e8f0", fontSize: "13px" }}>
              Auto-provision my keys
            </span>
            <span style={{ fontSize: "11px", color: "#6b7280" }}>
              — opens provider dashboard, creates key automatically
            </span>
          </div>
          <p style={{ fontSize: "12px", color: "#9ca3af", margin: "0 0 10px" }}>
            You must already be signed in to the provider in Chrome.
            The agent will open the API key page, click Create, and save the key.
          </p>
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <select
              value={apProvider}
              onChange={(e) => setApProvider((e.target as HTMLSelectElement).value as "google" | "groq")}
              style={{
                background: "#1e293b",
                border: "1px solid #334155",
                borderRadius: "6px",
                padding: "7px 10px",
                color: "#f1f5f9",
                fontSize: "12px",
                cursor: "pointer",
              }}
            >
              <option value="google">Google AI Studio</option>
              <option value="groq">Groq</option>
            </select>
            <button
              onClick={handleAutoProvision}
              disabled={apWorking}
              style={{
                ...btnBase,
                background: apWorking ? "#374151" : "#d97706",
                color: apWorking ? "#6b7280" : "#fff",
                cursor: apWorking ? "not-allowed" : "pointer",
              }}
            >
              {apWorking ? "Provisioning…" : "Auto-provision"}
            </button>
          </div>
          {apStatus && (
            <p style={{
              fontSize: "12px",
              color: apStatus.startsWith("Error") ? "#f87171" : "#4ade80",
              margin: "8px 0 0",
            }}>
              {apStatus}
            </p>
          )}
        </div>

      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Small UI atoms
// ---------------------------------------------------------------------------

function SectionTitle({ children }: { children: ComponentChildren }) {
  return (
    <h2
      style={{
        fontSize: "11px",
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.08em",
        color: "#6b7280",
        margin: "0 0 12px",
        padding: "0 0 6px",
        borderBottom: "1px solid #1f2937",
      }}
    >
      {children}
    </h2>
  );
}

function Badge({ color, children }: { color: "green" | "red" | "yellow" | "blue"; children: string }) {
  const colors = {
    green: { bg: "#052e16", text: "#4ade80", border: "#166534" },
    red: { bg: "#450a0a", text: "#f87171", border: "#991b1b" },
    yellow: { bg: "#422006", text: "#fbbf24", border: "#92400e" },
    blue: { bg: "#0c1a4e", text: "#818cf8", border: "#3730a3" },
  };
  const c = colors[color];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "1px 7px",
        borderRadius: "9999px",
        fontSize: "10px",
        fontWeight: 500,
        background: c.bg,
        color: c.text,
        border: `1px solid ${c.border}`,
      }}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// AddKeyForm
// ---------------------------------------------------------------------------

interface AddKeyFormProps {
  providerId: ProviderId;
  onSaved: () => void;
}

function AddKeyForm({ providerId, onSaved }: AddKeyFormProps) {
  const [label, setLabel] = useState("");
  const [plaintext, setPlaintext] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const meta = PROVIDERS.find((p) => p.id === providerId)!;

  const handleSave = async () => {
    if (!plaintext.trim()) {
      setError("API key is required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await chrome.runtime.sendMessage({
        kind: "keys:save",
        provider: providerId,
        label: label.trim() || meta.label,
        plaintext: plaintext.trim(),
      });
      setLabel("");
      setPlaintext("");
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save key");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        background: "#0f172a",
        border: "1px solid #1e293b",
        borderRadius: "10px",
        padding: "12px",
        marginBottom: "8px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px" }}>
        <span style={{ fontWeight: 600, color: "#e2e8f0", fontSize: "13px" }}>{meta.label}</span>
        <a href={meta.docsUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: "11px" }}>
          Get key ↗
        </a>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        <input
          type="text"
          placeholder="Label (optional)"
          value={label}
          onInput={(e) => setLabel((e.target as HTMLInputElement).value)}
          style={{
            background: "#1e293b",
            border: "1px solid #334155",
            borderRadius: "6px",
            padding: "6px 10px",
            color: "#f1f5f9",
            fontSize: "12px",
            outline: "none",
            width: "100%",
          }}
        />
        <div style={{ display: "flex", gap: "8px" }}>
          <input
            type="password"
            placeholder={meta.placeholder}
            value={plaintext}
            onInput={(e) => setPlaintext((e.target as HTMLInputElement).value)}
            style={{
              background: "#1e293b",
              border: "1px solid #334155",
              borderRadius: "6px",
              padding: "6px 10px",
              color: "#f1f5f9",
              fontSize: "12px",
              outline: "none",
              flex: 1,
              fontFamily: "ui-monospace, monospace",
            }}
            onKeyDown={(e) => e.key === "Enter" && handleSave()}
          />
          <button
            onClick={handleSave}
            disabled={saving || !plaintext.trim()}
            style={{
              background: saving || !plaintext.trim() ? "#374151" : "#4f46e5",
              color: saving || !plaintext.trim() ? "#6b7280" : "#fff",
              border: "none",
              borderRadius: "6px",
              padding: "6px 14px",
              fontSize: "12px",
              fontWeight: 500,
              cursor: saving || !plaintext.trim() ? "not-allowed" : "pointer",
              transition: "background 0.15s",
            }}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
        {error && <p style={{ color: "#f87171", fontSize: "11px", margin: 0 }}>{error}</p>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SavedKeyRow
// ---------------------------------------------------------------------------

interface SavedKeyRowProps {
  storedKey: StoredKey;
  onDeleted: () => void;
}

function SavedKeyRow({ storedKey, onDeleted }: SavedKeyRowProps) {
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "pass" | "fail">("idle");
  const [testError, setTestError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const meta = PROVIDERS.find((p) => p.id === storedKey.provider);

  const handleTest = async () => {
    setTestStatus("testing");
    setTestError(null);
    try {
      const resp = await chrome.runtime.sendMessage({
        kind: "keys:test",
        id: storedKey.id,
      }) as { ok: boolean; error?: string } | undefined;
      if (resp?.ok) {
        setTestStatus("pass");
      } else {
        setTestStatus("fail");
        setTestError(resp?.error ?? "Test failed");
      }
    } catch (err) {
      setTestStatus("fail");
      setTestError(err instanceof Error ? err.message : "Test failed");
    }
  };

  const handleDelete = async () => {
    if (!confirm(`Delete key "${storedKey.label}"?`)) return;
    setDeleting(true);
    try {
      await chrome.runtime.sendMessage({ kind: "keys:delete", id: storedKey.id });
      onDeleted();
    } catch {
      setDeleting(false);
    }
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "10px",
        padding: "8px 10px",
        background: "#0f172a",
        border: "1px solid #1e293b",
        borderRadius: "8px",
        marginBottom: "6px",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: "12px", fontWeight: 500, color: "#e2e8f0", marginBottom: "2px" }}>
          {storedKey.label}
        </div>
        <div style={{ fontSize: "11px", color: "#6b7280" }}>
          {meta?.label ?? storedKey.provider} · Added {new Date(storedKey.created_at).toLocaleDateString()}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
        {testStatus === "pass" && <Badge color="green">Pass</Badge>}
        {testStatus === "fail" && <Badge color="red">{testError ?? "Fail"}</Badge>}

        <button
          onClick={handleTest}
          disabled={testStatus === "testing"}
          style={{
            background: "transparent",
            border: "1px solid #374151",
            borderRadius: "5px",
            padding: "3px 8px",
            fontSize: "11px",
            color: "#9ca3af",
            cursor: testStatus === "testing" ? "not-allowed" : "pointer",
          }}
        >
          {testStatus === "testing" ? "Testing…" : "Test"}
        </button>

        <button
          onClick={handleDelete}
          disabled={deleting}
          style={{
            background: "transparent",
            border: "1px solid #374151",
            borderRadius: "5px",
            padding: "3px 8px",
            fontSize: "11px",
            color: "#ef4444",
            cursor: deleting ? "not-allowed" : "pointer",
          }}
          aria-label={`Delete ${storedKey.label}`}
        >
          {deleting ? "…" : "Delete"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PriorityChain
// ---------------------------------------------------------------------------

// ProviderPriorityList is Array<{ providerId, model, key_ids, enabled }>
// We only reorder the list items — each entry's providerId identifies the row.

interface PriorityChainProps {
  priorityList: ProviderPriorityList;
  onChange: (list: ProviderPriorityList) => void;
}

function PriorityChain({ priorityList, onChange }: PriorityChainProps) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const moveUp = (idx: number) => {
    if (idx === 0) return;
    const next = [...priorityList] as ProviderPriorityList;
    [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
    onChange(next);
  };

  const moveDown = (idx: number) => {
    if (idx === priorityList.length - 1) return;
    const next = [...priorityList] as ProviderPriorityList;
    [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
    onChange(next);
  };

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await chrome.runtime.sendMessage({ kind: "priority:set", list: priorityList });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      {priorityList.map((entry, idx) => {
        const meta = PROVIDERS.find((p) => p.id === entry.providerId);
        return (
          <div
            key={entry.providerId}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              padding: "7px 10px",
              background: "#0f172a",
              border: "1px solid #1e293b",
              borderRadius: "8px",
              marginBottom: "6px",
            }}
          >
            <span style={{ fontSize: "12px", color: "#9ca3af", width: "16px", textAlign: "center" }}>
              {idx + 1}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <span style={{ fontSize: "12px", fontWeight: 500, color: "#e2e8f0" }}>
                {meta?.label ?? entry.providerId}
              </span>
              {entry.model && (
                <span style={{ fontSize: "10px", color: "#6b7280", marginLeft: "6px" }}>
                  {entry.model}
                </span>
              )}
            </div>
            {!entry.enabled && <Badge color="yellow">Disabled</Badge>}
            <div style={{ display: "flex", gap: "3px" }}>
              <button
                onClick={() => moveUp(idx)}
                disabled={idx === 0}
                style={{
                  background: "transparent",
                  border: "1px solid #374151",
                  borderRadius: "4px",
                  padding: "2px 6px",
                  fontSize: "10px",
                  color: idx === 0 ? "#374151" : "#9ca3af",
                  cursor: idx === 0 ? "not-allowed" : "pointer",
                }}
                aria-label="Move up"
              >
                ▲
              </button>
              <button
                onClick={() => moveDown(idx)}
                disabled={idx === priorityList.length - 1}
                style={{
                  background: "transparent",
                  border: "1px solid #374151",
                  borderRadius: "4px",
                  padding: "2px 6px",
                  fontSize: "10px",
                  color: idx === priorityList.length - 1 ? "#374151" : "#9ca3af",
                  cursor: idx === priorityList.length - 1 ? "not-allowed" : "pointer",
                }}
                aria-label="Move down"
              >
                ▼
              </button>
            </div>
          </div>
        );
      })}

      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "10px" }}>
        <button
          onClick={handleSave}
          disabled={saving}
          style={{
            background: saving ? "#374151" : "#4f46e5",
            color: saving ? "#6b7280" : "#fff",
            border: "none",
            borderRadius: "6px",
            padding: "6px 16px",
            fontSize: "12px",
            fontWeight: 500,
            cursor: saving ? "not-allowed" : "pointer",
          }}
        >
          {saving ? "Saving…" : "Save order"}
        </button>
        {saved && <Badge color="green">Saved</Badge>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LiveRouting
// ---------------------------------------------------------------------------

function LiveRouting() {
  const [currentRoute, setCurrentRoute] = useState<string | null>(null);
  const [lastUsed, setLastUsed] = useState<string | null>(null);

  useEffect(() => {
    const listener = (msg: unknown) => {
      const m = msg as { kind?: string; provider?: string; model?: string; timestamp?: string | number };
      if (m?.kind === "routing-update" && m.provider) {
        setCurrentRoute(`${m.provider}/${m.model ?? "unknown"}`);
        if (m.timestamp) {
          setLastUsed(new Date(m.timestamp as string).toLocaleTimeString());
        }
      }
    };
    chrome.runtime.onMessage.addListener(listener as Parameters<typeof chrome.runtime.onMessage.addListener>[0]);
    return () => {
      chrome.runtime.onMessage.removeListener(listener as Parameters<typeof chrome.runtime.onMessage.removeListener>[0]);
    };
  }, []);

  if (!currentRoute) {
    return (
      <p style={{ fontSize: "12px", color: "#4b5563", margin: 0 }}>
        No routing data yet — run the agent to see which provider is used.
      </p>
    );
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
      <Badge color="blue">{currentRoute}</Badge>
      {lastUsed && (
        <span style={{ fontSize: "11px", color: "#6b7280" }}>Last used at {lastUsed}</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// App (main)
// ---------------------------------------------------------------------------

export default function App() {
  const [storedKeys, setStoredKeys] = useState<StoredKey[]>([]);
  const [priorityList, setPriorityList] = useState<ProviderPriorityList>([]);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    // MV3 sendMessage can stay pending forever if the service worker returns
    // `true` (async) but never calls sendResponse (e.g. SW cold-start / not yet
    // listening). Race each call against a timeout so the settings UI never
    // hangs on "Loading…" — a fresh profile simply renders with empty keys.
    const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T | undefined> =>
      Promise.race([p, new Promise<undefined>((res) => setTimeout(() => res(undefined), ms))]);
    try {
      const [keysResp, priorityResp] = await Promise.all([
        withTimeout(chrome.runtime.sendMessage({ kind: "keys:list" }), 2500) as Promise<StoredKey[] | undefined>,
        withTimeout(chrome.runtime.sendMessage({ kind: "priority:get" }), 2500) as Promise<ProviderPriorityList | undefined>,
      ]);
      if (keysResp) setStoredKeys(keysResp);
      if (priorityResp && priorityResp.length > 0) setPriorityList(priorityResp);
    } catch {
      // background may not be ready yet
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    document.documentElement.classList.add("dark");
    loadData();
  }, [loadData]);

  return (
    <Fragment>
      <style>{globalStyle}</style>

      <div>
        {/* Page header */}
        <div style={{ marginBottom: "28px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "6px" }}>
            <div
              style={{
                width: "28px",
                height: "28px",
                borderRadius: "8px",
                background: "#4f46e5",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="currentColor"
                style={{ color: "#fff" }}
                aria-hidden="true"
              >
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
              </svg>
            </div>
            <h1 style={{ margin: 0, fontSize: "18px", fontWeight: 700, color: "#f9fafb" }}>
              Free Browser Agent
            </h1>
          </div>
          <p style={{ margin: 0, fontSize: "12px", color: "#6b7280" }}>
            Settings · Configure your API keys and fallback chain
          </p>
        </div>

        {loading ? (
          <p style={{ color: "#6b7280", fontSize: "13px" }}>Loading…</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "32px" }}>

            {/* --- Onboarding (Quick Start) --- */}
            <OnboardingSection />

            {/* --- Advanced: manual key paste --- */}
            <details>
              <summary
                style={{
                  cursor: "pointer",
                  fontSize: "12px",
                  fontWeight: 600,
                  color: "#6b7280",
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  userSelect: "none",
                  listStyle: "none",
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  padding: "8px 0",
                  borderBottom: "1px solid #1f2937",
                }}
              >
                <span>▶</span> Advanced: paste your own keys
              </summary>

              <div style={{ display: "flex", flexDirection: "column", gap: "24px", marginTop: "20px" }}>

                {/* --- API Keys --- */}
                <section>
                  <SectionTitle>API Keys</SectionTitle>
                  <p style={{ fontSize: "12px", color: "#6b7280", marginBottom: "16px", marginTop: 0 }}>
                    Add keys for any free-tier provider. All keys are encrypted at rest using AES-256-GCM.
                  </p>

                  {PROVIDERS.map((provider) => (
                    <AddKeyForm
                      key={provider.id}
                      providerId={provider.id}
                      onSaved={loadData}
                    />
                  ))}
                </section>

              </div>
            </details>

            {/* --- Saved Keys --- */}
            {storedKeys.length > 0 && (
              <section>
                <SectionTitle>Saved Keys ({storedKeys.length})</SectionTitle>
                {storedKeys.map((key) => (
                  <SavedKeyRow
                    key={key.id}
                    storedKey={key}
                    onDeleted={loadData}
                  />
                ))}
              </section>
            )}

            {/* --- Fallback Chain --- */}
            <section>
              <SectionTitle>Fallback Chain</SectionTitle>
              <p style={{ fontSize: "12px", color: "#6b7280", marginBottom: "14px", marginTop: 0 }}>
                Providers are tried in order from top to bottom. On rate-limit or error, the next provider in the chain is used automatically.
              </p>
              <PriorityChain
                priorityList={priorityList}
                onChange={setPriorityList}
              />
            </section>

            {/* --- Live Routing --- */}
            <section>
              <SectionTitle>Current Routing</SectionTitle>
              <LiveRouting />
            </section>

          </div>
        )}
      </div>
    </Fragment>
  );
}

const root = document.getElementById("root");
if (root) render(h(App, {}), root);
