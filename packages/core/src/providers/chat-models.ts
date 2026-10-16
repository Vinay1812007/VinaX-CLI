import { isNvidiaFreeChatModel, nvidiaFreeRank } from './nvidia-free.js';
import type { ModelInfo, ProviderName } from './types.js';

/** Keep unknown context sizes, but exclude endpoints that cannot take a chat conversation. */
export function chatModels(models: readonly ModelInfo[], provider: ProviderName): ModelInfo[] {
  return models
    .filter((m) => {
      if (m.contextWindow !== undefined && m.contextWindow < 8192) return false;
      if (
        /embed|rerank|whisper|tts|transcri|dall-e|imagegen|moderation|stable-diffusion|flux|sora|realtime|audio|gpt-image/i.test(
          m.id,
        )
      )
        return false;
      if (provider === 'openai' && !/^(gpt-|chatgpt-|o\d)/.test(m.id)) return false;
      if (provider === 'openai' && /codex|deep-research|(^|-)pro($|-)/.test(m.id)) return false;
      // only NVIDIA's free endpoints, and those in the order of nvidia-free.ts (best first)
      if (provider === 'nvidia' && !isNvidiaFreeChatModel(m.id)) return false;
      return true;
    })
    .sort(
      (a, b) =>
        Number(b.free) - Number(a.free) ||
        (provider === 'nvidia' ? (nvidiaFreeRank(a.id) ?? 0) - (nvidiaFreeRank(b.id) ?? 0) : 0) ||
        a.id.localeCompare(b.id),
    );
}

/** APIs that bill every request, so nothing they list can be tried for free. */
export const PAID_ONLY_PROVIDERS: readonly ProviderName[] = ['openai', 'claude', 'deepseek'];

/**
 * Whether a model can be used without paying. A published non-zero price is proof it cannot; a
 * paid-only API is the same by provider. Everything else is a provider with a free tier whose
 * catalog publishes no price (Groq, Gemini, NVIDIA, Cerebras, Z.AI, ModelScope, …), which is as
 * close to "free tier" as the catalogs let us get.
 */
export function freeToTry(
  provider: ProviderName,
  info: Partial<Pick<ModelInfo, 'free' | 'pricing'>>,
): boolean {
  if (info.free === true) return true;
  if (info.pricing !== undefined && (info.pricing.prompt > 0 || info.pricing.completion > 0))
    return false;
  return !PAID_ONLY_PROVIDERS.includes(provider);
}
