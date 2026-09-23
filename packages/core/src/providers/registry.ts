import type { ResolvedSettings } from '../config/schema.js';
import type { SecretStore } from '../config/secrets.js';
import type { Logger } from '../log/logger.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import type { RateLimitLedger } from './ratelimit.js';
import { PROVIDER_NAMES, type Provider, type ProviderName } from './types.js';

export const PROJECT_URL = 'https://github.com/Vinay1812007/VinaX-CLI';

const PER_PROVIDER: Record<
  ProviderName,
  { keyCheckPath: string; headers?: Record<string, string> }
> = {
  groq: { keyCheckPath: '/models' },
  // OpenRouter's /models is public, so /key is the call that actually proves the key works.
  openrouter: {
    keyCheckPath: '/key',
    headers: { 'HTTP-Referer': PROJECT_URL, 'X-Title': 'VinaX CLI' },
  },
};

export function createProvider(
  name: ProviderName,
  apiKey: string,
  deps: { settings: ResolvedSettings; ledger: RateLimitLedger; logger: Logger },
): Provider {
  const conf = deps.settings.providers[name];
  const extra = PER_PROVIDER[name];
  return new OpenAICompatibleProvider({
    name,
    apiKey,
    baseURL: conf.baseUrl,
    timeoutMs: deps.settings.router.requestTimeoutMs,
    ledger: deps.ledger,
    logger: deps.logger,
    keyCheckPath: extra.keyCheckPath,
    ...(extra.headers ? { defaultHeaders: extra.headers } : {}),
  });
}

export interface ProviderSet {
  providers: Map<ProviderName, Provider>;
  /** Enabled providers that have no API key configured. */
  missingKeys: ProviderName[];
}

export async function createProviders(deps: {
  settings: ResolvedSettings;
  secrets: SecretStore;
  ledger: RateLimitLedger;
  logger: Logger;
}): Promise<ProviderSet> {
  const providers = new Map<ProviderName, Provider>();
  const missingKeys: ProviderName[] = [];
  for (const name of PROVIDER_NAMES) {
    if (!deps.settings.providers[name].enabled) continue;
    const key = await deps.secrets.get(name);
    if (key === undefined) {
      missingKeys.push(name);
      continue;
    }
    providers.set(name, createProvider(name, key.value, deps));
  }
  return { providers, missingKeys };
}
