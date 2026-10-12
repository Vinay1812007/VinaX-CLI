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
      return true;
    })
    .sort((a, b) => Number(b.free) - Number(a.free) || a.id.localeCompare(b.id));
}
