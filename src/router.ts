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
import { listKeys, getKey } from './storage/keys.js';
import { isOverLimit, recordRequest, setCooldown, getCooldown } from './storage/ratelimit.js';

const MAX_ATTEMPTS = 20;
const INITIAL_COOLDOWN_MS = 30_000;
const MAX_COOLDOWN_MS = 300_000;

const PROVIDER_INSTANCES = {
  google: new GoogleProvider(),
  groq: new GroqProvider(),
  cerebras: new CerebrasProvider(),
  openrouter: new OpenRouterProvider(),
} as const;

const DEFAULT_PRIORITY: ProviderPriorityList = [
  { providerId: 'groq', model: 'llama-3.3-70b-versatile', key_ids: [], enabled: true },
  { providerId: 'google', model: 'gemini-2.0-flash', key_ids: [], enabled: true },
  { providerId: 'cerebras', model: 'llama-3.3-70b', key_ids: [], enabled: true },
  { providerId: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct:free', key_ids: [], enabled: true },
];

const PROVIDER_LIMITS: Record<ProviderId, { rpm: number; rpd: number; tpm: number; tpd: number }> = {
  google:     { rpm: 15, rpd: 1500,  tpm: 1_000_000, tpd: 0 },
  groq:       { rpm: 30, rpd: 14400, tpm: 6000,       tpd: 0 },
  cerebras:   { rpm: 30, rpd: 0,     tpm: 60000,      tpd: 0 },
  openrouter: { rpm: 20, rpd: 200,   tpm: 0,          tpd: 0 },
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
        const response = await provider.chatCompletion(plaintext, messages, model, options);
        const latencyMs = Date.now() - startMs;

        const tokens = response.usage?.total_tokens ?? 0;
        await recordRequest(providerId, model, keyId, tokens);

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

    throw new Error('All providers exhausted after ' + MAX_ATTEMPTS + ' attempts. Last error: ' + lastError.message);
  }

  private async buildCandidateList(): Promise<Candidate[]> {
    const allKeys = await listKeys();
    const candidates: Candidate[] = [];

    for (const entry of this.priorityList) {
      if (!entry.enabled) continue;
      const { providerId, model } = entry;
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
      const limits = limits_map[providerId];

      const cooldownUntil = await getCooldown(providerId, model, keyId);
      if (cooldownUntil > nowMs) continue;

      const over = await isOverLimit(providerId, model, keyId, limits);
      if (over) continue;

      return candidate;
    }

    return null;
  }
}
