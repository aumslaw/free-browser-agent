/**
 * src/router.ts
 *
 * Priority-ordered provider router with per-key rate-limit ledger and
 * exponential-backoff cooldown.
 */

import type { ChatMessage, AssistantMessage, ProviderId, ProviderPriorityList } from './shared/types.js';
import type { Tool } from './shared/tools.js';
import type { CompletionOptions } from './providers/base.js';
import { GoogleProvider } from './providers/google.js';
import { GroqProvider } from './providers/groq.js';
import { CerebrasProvider } from './providers/cerebras.js';
import { OpenRouterProvider } from './providers/openrouter.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { ChromeAIProvider, isChromeAIAvailable } from './providers/chrome-ai.js';
import { listKeys, getKey } from './storage/keys.js';
import { isOverLimit, recordRequest, setCooldown, getCooldown } from './storage/ratelimit.js';

const MAX_ATTEMPTS = 20;
const INITIAL_COOLDOWN_MS = 30_000;
const MAX_COOLDOWN_MS = 300_000;

const PROVIDER_INSTANCES: Record<ProviderId, InstanceType<typeof ChromeAIProvider> | InstanceType<typeof GoogleProvider> | InstanceType<typeof GroqProvider> | InstanceType<typeof CerebrasProvider> | InstanceType<typeof OpenRouterProvider> | InstanceType<typeof AnthropicProvider>> = {
  'chrome-ai': new ChromeAIProvider(),
  google: new GoogleProvider(),
  groq: new GroqProvider(),
  cerebras: new CerebrasProvider(),
  openrouter: new OpenRouterProvider(),
  anthropic: new AnthropicProvider(),
};

const DEFAULT_PRIORITY: ProviderPriorityList = [
  { providerId: 'chrome-ai', model: 'gemini-nano', key_ids: [], enabled: true },
  { providerId: 'groq', model: 'llama-3.3-70b-versatile', key_ids: [], enabled: true },
  { providerId: 'google', model: 'gemini-2.0-flash', key_ids: [], enabled: true },
  { providerId: 'cerebras', model: 'llama-3.3-70b', key_ids: [], enabled: true },
  { providerId: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct:free', key_ids: [], enabled: true },
  { providerId: 'anthropic', model: 'claude-haiku-4-5-20251001', key_ids: [], enabled: true },
];

const PROVIDER_LIMITS: Record<ProviderId, { rpm: number; rpd: number; tpm: number; tpd: number }> = {
  'chrome-ai': { rpm: 0, rpd: 0,     tpm: 0,          tpd: 0 },
  google:      { rpm: 15, rpd: 1500,  tpm: 1_000_000, tpd: 0 },
  groq:        { rpm: 30, rpd: 14400, tpm: 6000,       tpd: 0 },
  cerebras:    { rpm: 30, rpd: 0,     tpm: 60000,      tpd: 0 },
  openrouter:  { rpm: 20, rpd: 200,   tpm: 0,          tpd: 0 },
  anthropic:   { rpm: 60, rpd: 0,     tpm: 0,          tpd: 0 },
};

export interface RouterCompletionResult {
  message: AssistantMessage;
  providerUsed: string;
}

type Candidate = { providerId: ProviderId; model: string; keyId: string; plaintext: string };

export class Router {
  private priorityList: ProviderPriorityList = DEFAULT_PRIORITY;

  setPriorityList(list: ProviderPriorityList): void {
    this.priorityList = list;
  }

  async chatCompletion(
    messages: ChatMessage[],
    tools?: Tool[],
  ): Promise<RouterCompletionResult> {
    const candidates = await this.buildCandidateList();

    if (candidates.length === 0) {
      throw new Error(
        'No provider keys configured. Open Settings and paste at least one API key.',
      );
    }

    const toolDefs = tools?.map((t) => ({
      type: t.type as 'function',
      function: {
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters as unknown as Record<string, unknown>,
      },
    }));
    const options: CompletionOptions = toolDefs?.length ? { tools: toolDefs } : {};

    let lastError: Error = new Error('No eligible providers found.');

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const candidate = await this.pickCandidate(candidates);
      if (!candidate) break;

      const { providerId, model, keyId, plaintext } = candidate;
      const provider = PROVIDER_INSTANCES[providerId];
      const startMs = Date.now();

      try {
        let response;
        if (providerId === 'chrome-ai') {
          // The Prompt API is not available in SW context — proxy via offscreen doc
          response = await this.dispatchChromeAIViaOffscreen(messages, model);
        } else {
          response = await provider.chatCompletion(plaintext, messages, model, options);
        }
        const latencyMs = Date.now() - startMs;

        const tokens = response.usage?.total_tokens ?? 0;
        if (providerId !== 'chrome-ai') {
          await recordRequest(providerId, model, keyId, tokens);
        }

        const choice = response.choices[0];
        const assistantMsg: AssistantMessage = {
          role: 'assistant',
          content: choice.message.content ?? null,
          tool_calls: choice.message.tool_calls,
          _routed_via: providerId + '/' + model + ' (' + latencyMs + 'ms)',
        };

        return { message: assistantMsg, providerUsed: providerId + '/' + model };

      } catch (err) {
        const status = (err as Error & { status?: number }).status ?? 0;
        lastError = err instanceof Error ? err : new Error(String(err));

        // Don't set cooldown for chrome-ai — it's local and errors are permanent
        if (providerId !== 'chrome-ai') {
          const cooldownMs = Math.min(
            INITIAL_COOLDOWN_MS * Math.pow(2, attempt),
            MAX_COOLDOWN_MS,
          );

          if (status === 429 || (status >= 500 && status < 600)) {
            await setCooldown(providerId, model, keyId, Date.now() + cooldownMs);
          } else {
            await setCooldown(providerId, model, keyId, Date.now() + MAX_COOLDOWN_MS);
          }
        }
      }
    }

    throw new Error('All providers exhausted after ' + MAX_ATTEMPTS + ' attempts. Last error: ' + lastError.message);
  }

  private async buildCandidateList(): Promise<Candidate[]> {
    const allKeys = await listKeys();
    const candidates: Candidate[] = [];

    for (const entry of this.priorityList) {
      if (!entry.enabled) continue;
      const { providerId, model } = entry;

      // chrome-ai is keyless — check availability instead of stored keys
      if (providerId === 'chrome-ai') {
        const available = await isChromeAIAvailable();
        if (available) {
          candidates.push({ providerId, model, keyId: 'chrome-ai-local', plaintext: '' });
        }
        continue;
      }

      const keysForProvider = allKeys.filter((k) => k.provider === providerId);
      if (keysForProvider.length === 0) continue;

      for (const storedKey of keysForProvider) {
        try {
          const plaintext = await getKey(storedKey.provider, storedKey.id);
          if (plaintext === null) continue;
          candidates.push({ providerId, model, keyId: storedKey.id, plaintext });
        } catch {
          // Key decrypt failed — skip silently
        }
      }
    }

    return candidates;
  }

  private async pickCandidate(candidates: Candidate[]): Promise<Candidate | null> {
    const nowMs = Date.now();
    const limits_map = PROVIDER_LIMITS;

    for (const candidate of candidates) {
      const { providerId, model, keyId } = candidate;

      // chrome-ai is on-device — no rate-limit or cooldown applies
      if (providerId === 'chrome-ai') {
        return candidate;
      }

      const limits = limits_map[providerId];

      const cooldownUntil = await getCooldown(providerId, model, keyId);
      if (cooldownUntil > nowMs) continue;

      const over = await isOverLimit(providerId, model, keyId, limits);
      if (over) continue;

      return candidate;
    }

    return null;
  }

  /**
   * Proxy a chrome-ai inference through an offscreen document, because the
   * Chrome Prompt API (LanguageModel / self.ai.languageModel) is not available
   * inside MV3 service workers.
   *
   * Creates the offscreen document on first call (guarded by hasDocument check),
   * then sends a {kind:"chrome-ai-infer"} message and awaits the response.
   */
  private async dispatchChromeAIViaOffscreen(
    messages: ChatMessage[],
    model: string,
  ): Promise<import('./providers/base.js').ChatCompletionResponse> {
    // Ensure the offscreen document exists (idempotent — Chrome ignores if already open)
    try {
      const existing = await (chrome.offscreen as unknown as {
        hasDocument(): Promise<boolean>;
      }).hasDocument();
      if (!existing) {
        await chrome.offscreen.createDocument({
          url: 'offscreen.html',
          reasons: ['DOM_SCRAPING' as chrome.offscreen.Reason],
          justification: 'Run Chrome built-in AI (Gemini Nano) Prompt API in a window context',
        });
      }
    } catch {
      // If hasDocument / createDocument fail (e.g. not in SW context, or already exists)
      // fall through and attempt the message — it may succeed.
    }

    type OffscreenReply =
      | { ok: true; result: import('./providers/base.js').ChatCompletionResponse }
      | { ok: false; error: string };

    const reply = await chrome.runtime.sendMessage({
      kind: 'chrome-ai-infer',
      messages,
      model,
      stream: false,
    }) as OffscreenReply | undefined;

    if (!reply) {
      throw new Error('[chrome-ai] No response from offscreen document — is offscreen.html loaded?');
    }
    if (!reply.ok) {
      throw new Error('[chrome-ai] Offscreen inference failed: ' + reply.error);
    }
    return reply.result;
  }
}
