import type { ResolvedSettings } from '../config/schema.js';
import type { SecretStore } from '../config/secrets.js';
import type { Logger } from '../log/logger.js';
import { GatewayClient } from './gateway.js';
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

/** A provider reached through the VinaX gateway, authenticated with the gateway token. */
export function createGatewayProvider(
  name: ProviderName,
  gateway: GatewayClient,
  token: string,
  deps: { settings: ResolvedSettings; ledger: RateLimitLedger; logger: Logger },
): Provider {
  return new OpenAICompatibleProvider({
    name,
    apiKey: token,
    baseURL: gateway.baseURL,
    timeoutMs: Math.max(deps.settings.router.requestTimeoutMs, gateway.timeoutMs),
    ledger: deps.ledger,
    logger: deps.logger,
    keyCheckPath: '/models',
    gateway,
  });
}

export function createGatewayClient(settings: ResolvedSettings, url: string): GatewayClient {
  return new GatewayClient(url, { timeoutMs: settings.gateway.timeoutMs });
}

export interface ProviderSet {
  providers: Map<ProviderName, Provider>;
  /** Enabled providers that have neither an API key nor a gateway to go through. */
  missingKeys: ProviderName[];
  /** Set when the user logged in to a VinaX gateway (URL in settings, token stored). */
  gateway: { client: GatewayClient; token: string } | undefined;
  /** Providers served through the gateway because the user has no key of their own. */
  viaGateway: Set<ProviderName>;
}

export async function createProviders(deps: {
  settings: ResolvedSettings;
  secrets: SecretStore;
  ledger: RateLimitLedger;
  logger: Logger;
}): Promise<ProviderSet> {
  const providers = new Map<ProviderName, Provider>();
  const missingKeys: ProviderName[] = [];
  const viaGateway = new Set<ProviderName>();
  const url = deps.settings.gateway.url;
  const token = url === undefined ? undefined : await deps.secrets.get('gateway');
  const gateway =
    url === undefined || token === undefined
      ? undefined
      : { client: createGatewayClient(deps.settings, url), token: token.value };
  for (const name of PROVIDER_NAMES) {
    if (!deps.settings.providers[name].enabled) continue;
    const key = await deps.secrets.get(name);
    if (key !== undefined) {
      providers.set(name, createProvider(name, key.value, deps));
    } else if (gateway) {
      providers.set(name, createGatewayProvider(name, gateway.client, gateway.token, deps));
      viaGateway.add(name);
    } else {
      missingKeys.push(name);
    }
  }
  return { providers, missingKeys, gateway, viaGateway };
}
