import type { ProviderName } from '../config/schema.js';

/**
 * Models VinaX knows about ahead of the provider catalog: short aliases and metadata the
 * provider's `/models` endpoint does not report (NVIDIA's catalog lists ids only).
 */
export interface KnownModel {
  provider: ProviderName;
  /** Model id as the provider knows it. */
  model: string;
  /** Short name accepted anywhere a `<provider>:<model>` ref is, e.g. `--model NVD_CHAT_OSS_20_B`. */
  alias: string | undefined;
  /** Human-friendly name for pickers. */
  label: string;
  contextWindow: number | undefined;
}

export const KNOWN_MODELS: readonly KnownModel[] = [
  {
    provider: 'nvidia',
    model: 'openai/gpt-oss-20b',
    alias: 'NVD_CHAT_OSS_20_B',
    label: 'GPT-OSS 20B',
    contextWindow: 131_072,
  },
];

/** Alternative spellings of provider names, e.g. the provider's domain. */
const PROVIDER_SYNONYMS: Readonly<Record<string, ProviderName>> = {
  'groq.com': 'groq',
  'openrouter.ai': 'openrouter',
  'nvidia.com': 'nvidia',
};

const PROVIDER_HOSTS: Readonly<Record<ProviderName, string>> = {
  groq: 'groq.com',
  openrouter: 'openrouter.ai',
  nvidia: 'nvidia.com',
};

/** The provider's home domain, shown next to its name (e.g. "NVIDIA · nvidia.com"). */
export function providerHost(name: ProviderName): string {
  return PROVIDER_HOSTS[name];
}

function isProviderName(value: string): value is ProviderName {
  return Object.hasOwn(PROVIDER_HOSTS, value);
}

export function knownModel(provider: ProviderName, model: string): KnownModel | undefined {
  return KNOWN_MODELS.find((m) => m.provider === provider && m.model === model);
}

/** Alias for `<provider>:<model>`, if it has one. */
export function modelAlias(ref: string): string | undefined {
  return KNOWN_MODELS.find((m) => `${m.provider}:${m.model}` === ref)?.alias;
}

/**
 * Canonical `<provider>:<model>` for user input, or `undefined` when it is not a model ref.
 * Accepts aliases (case-insensitive) and provider domains (`nvidia.com:openai/gpt-oss-20b`).
 */
export function normalizeModelRef(input: string): string | undefined {
  const value = input.trim();
  if (value === '' || /\s/.test(value)) return undefined;
  const alias = KNOWN_MODELS.find((m) => m.alias?.toLowerCase() === value.toLowerCase());
  if (alias) return `${alias.provider}:${alias.model}`;
  const idx = value.indexOf(':');
  if (idx <= 0 || idx === value.length - 1) return undefined;
  const rawProvider = value.slice(0, idx).toLowerCase();
  const provider = isProviderName(rawProvider) ? rawProvider : PROVIDER_SYNONYMS[rawProvider];
  if (provider === undefined) return undefined;
  return `${provider}:${value.slice(idx + 1)}`;
}

/** Fills in what the provider's catalog left out (context window) from {@link KNOWN_MODELS}. */
export function withKnownMetadata<T extends { id: string; contextWindow: number | undefined }>(
  provider: ProviderName,
  models: readonly T[],
): T[] {
  return models.map((m) => {
    const known = knownModel(provider, m.id);
    return known?.contextWindow !== undefined && m.contextWindow === undefined
      ? { ...m, contextWindow: known.contextWindow }
      : m;
  });
}
