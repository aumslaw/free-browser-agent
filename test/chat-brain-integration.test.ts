/**
 * test/chat-brain-integration.test.ts
 *
 * Real-execution proof that free-browser-agent's chat BRAIN works end-to-end.
 *
 * Unlike the unit tests (which mock the providers) this wires the REAL modules
 * together — runAgentLoop → Router → GroqProvider → keys.ts → crypto.ts — and
 * mocks ONLY the two true externalities: chrome.storage (in-memory) and global
 * fetch (the Groq HTTP call). It proves, with real code paths:
 *
 *   1. A key saved via the real saveKey() is encrypted (real WebCrypto) and
 *      later decrypted by the router at dispatch time.
 *   2. chrome-ai is correctly NOT selected (no LanguageModel global in Node →
 *      isChromeAIAvailable() === false), so the router falls through to Groq.
 *   3. The real GroqProvider builds the request (correct URL + Bearer auth from
 *      the decrypted key) and parses the completion.
 *   4. runAgentLoop returns the assistant reply with no tool calls.
 *
 * This is the "type → reply" round-trip minus the cosmetic SW→panel
 * runtime.sendMessage UI hop (a production-standard transport that Playwright
 * cannot deliver to a panel opened as a tab — see the capability-probe lesson).
 */

// IMPORTANT: _chrome-mock MUST be the first import — it installs globalThis.chrome
// before the src module graph (cdp.ts touches chrome.debugger at top-level on import).
import { resetChromeStores } from "./_chrome-mock.js";
import { describe, it, expect, beforeEach, vi } from "vitest";

// ── real modules under test ──────────────────────────────────────────────────
import { saveKey } from "../src/storage/keys.js";
import { Router } from "../src/router.js";
import { runAgentLoop } from "../src/background/agent-loop.js";
import { AGENT_TOOLS } from "../src/shared/tools.js";

const REPLY = "BRAIN integration reply: chat works end-to-end";

describe("chat brain integration (real router + agent loop + keys + Groq provider)", () => {
  beforeEach(() => {
    resetChromeStores();
    vi.restoreAllMocks();
  });

  it("saves a key, the router decrypts it, dispatches to Groq, and the loop returns the reply", async () => {
    let captured: { url: string; auth: unknown; bodyHasMessages: boolean } | null = null;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const headers = (init.headers ?? {}) as Record<string, string>;
        captured = {
          url,
          auth: headers["Authorization"] ?? headers["authorization"],
          bodyHasMessages: typeof init.body === "string" && init.body.includes('"messages"'),
        };
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            id: "chatcmpl-int", object: "chat.completion", created: 1,
            model: "llama-3.3-70b-versatile",
            choices: [{ index: 0, message: { role: "assistant", content: REPLY }, finish_reason: "stop" }],
            usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 },
          }),
          text: async () => "",
        } as unknown as Response;
      }),
    );

    // 1. Save a real Groq key (real encrypt via WebCrypto + chrome.storage mock).
    const keyId = await saveKey("groq", "gsk_integration_key");
    expect(keyId).toMatch(/^k_/);

    // 2. Run the REAL agent loop with the REAL router. chrome-ai is absent in Node
    //    (no LanguageModel global) → router falls through to the stored Groq key.
    const router = new Router();
    router.setPriorityList([{ providerId: "groq", model: "llama-3.3-70b-versatile", key_ids: [], enabled: true }]);

    const onStatus = vi.fn();
    const final = await runAgentLoop({
      messages: [{ role: "user", content: "say the brain proof phrase" }],
      tools: AGENT_TOOLS,
      tabId: 1,
      router,
      onStatus,
    });

    // 3. The loop returned the real (mocked-HTTP) Groq reply.
    expect(final.role).toBe("assistant");
    expect(final.content).toBe(REPLY);

    // 4. The real GroqProvider hit the right endpoint with the DECRYPTED key as Bearer.
    expect(captured).not.toBeNull();
    expect(captured!.url).toContain("api.groq.com/openai/v1/chat/completions");
    expect(captured!.auth).toBe("Bearer gsk_integration_key");
    expect(captured!.bodyHasMessages).toBe(true);

    // 5. The loop emitted a "final answer" status (no tool calls).
    expect(onStatus).toHaveBeenCalled();
  });

  it("EXECUTES: LLM returns a click tool-call → the loop dispatches the DOM op to the page → finalizes", async () => {
    // Capture the dom-ops the agent loop dispatches to the content script, and
    // simulate a successful content-script response.
    const dispatched: unknown[] = [];
    (globalThis as Record<string, any>).chrome.tabs.sendMessage = vi.fn(async (_tabId: number, msg: unknown) => {
      dispatched.push(msg);
      return { ok: true, result: 'Clicked "#submit"' };
    });

    // The mocked LLM: round 1 → call the `click` tool; round 2 → final answer.
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      call++;
      const message =
        call === 1
          ? { role: "assistant", content: null, tool_calls: [{ id: "tc1", type: "function", function: { name: "click", arguments: JSON.stringify({ selector: "#submit" }) } }] }
          : { role: "assistant", content: "Done — I clicked the submit button." };
      const finish = call === 1 ? "tool_calls" : "stop";
      return {
        ok: true, status: 200, statusText: "OK",
        json: async () => ({ id: "c", object: "chat.completion", created: 1, model: "llama-3.3-70b-versatile", choices: [{ index: 0, message, finish_reason: finish }], usage: { total_tokens: 5 } }),
        text: async () => "",
      } as unknown as Response;
    }));

    await saveKey("groq", "gsk_exec_key");
    const router = new Router();
    router.setPriorityList([{ providerId: "groq", model: "llama-3.3-70b-versatile", key_ids: [], enabled: true }]);

    const actions: string[] = [];
    const final = await runAgentLoop({
      messages: [{ role: "user", content: "click the submit button" }],
      tools: AGENT_TOOLS,
      tabId: 7,
      router,
      onStatus: (s) => actions.push(s.action),
    });

    // The loop autonomously dispatched the click DOM op to the page (content script)…
    expect(dispatched.length).toBeGreaterThanOrEqual(1);
    expect(dispatched[0]).toMatchObject({ kind: "dom-op", payload: { op: "click", selector: "#submit" } });
    // …took TWO LLM round-trips (decide-to-act, then finalize)…
    expect(call).toBe(2);
    expect(actions.some((a) => a.includes("click"))).toBe(true);
    // …and produced a final answer after the tool result came back.
    expect(final.content).toContain("clicked the submit button");
  });
});
