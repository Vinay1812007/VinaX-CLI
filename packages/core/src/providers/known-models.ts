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
  /** Accepts images. */
  vision?: boolean;
  /**
   * `false` when the model cannot take native tool definitions (VinaX then uses its text tool
   * protocol). NVIDIA's Llama 3.2 Vision rejects requests that carry both images and tools.
   */
  tools?: false;
}

export const KNOWN_MODELS: readonly KnownModel[] = [
  {
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    alias: 'GEMINI_FLASH',
    label: 'Gemini 2.5 Flash',
    contextWindow: 1_000_000,
    vision: true,
  },
  {
    provider: 'gemini',
    model: 'gemini-2.5-pro',
    alias: 'GEMINI_PRO',
    label: 'Gemini 2.5 Pro',
    contextWindow: 1_000_000,
    vision: true,
  },
  {
    provider: 'openai',
    model: 'gpt-4.1-mini',
    alias: 'GPT_4_1_MINI',
    label: 'GPT-4.1 mini',
    contextWindow: 1_000_000,
    vision: true,
  },
  {
    provider: 'claude',
    model: 'claude-sonnet-4-5',
    alias: 'CLAUDE_SONNET',
    label: 'Claude Sonnet',
    contextWindow: 200_000,
    vision: true,
  },
  {
    provider: 'deepseek',
    model: 'deepseek-chat',
    alias: 'DEEPSEEK_CHAT',
    label: 'DeepSeek Chat',
    contextWindow: 128_000,
  },
  {
    provider: 'mistral',
    model: 'mistral-small-latest',
    alias: 'MISTRAL_SMALL',
    label: 'Mistral Small',
    contextWindow: 128_000,
  },
  {
    provider: 'nvidia',
    model: 'openai/gpt-oss-20b',
    alias: 'NVD_CHAT_OSS_20_B',
    label: 'GPT-OSS 20B',
    contextWindow: 131_072,
  },
  {
    provider: 'nvidia',
    model: 'meta/llama-3.2-11b-vision-instruct',
    alias: undefined,
    label: 'Llama 3.2 11B Vision',
    contextWindow: 131_072,
    vision: true,
    tools: false,
  },
  {
    provider: 'nvidia',
    model: 'meta/llama-3.2-90b-vision-instruct',
    alias: undefined,
    label: 'Llama 3.2 90B Vision',
    contextWindow: 131_072,
    vision: true,
    tools: false,
  },
];

/** Alternative spellings of provider names, e.g. the provider's domain. */
const PROVIDER_SYNONYMS: Readonly<Record<string, ProviderName>> = {
  'groq.com': 'groq',
  'openrouter.ai': 'openrouter',
  'nvidia.com': 'nvidia',
  'ai.google.dev': 'gemini',
  'openai.com': 'openai',
  'anthropic.com': 'claude',
  'deepseek.com': 'deepseek',
  'mistral.ai': 'mistral',
};

const PROVIDER_HOSTS: Readonly<Record<ProviderName, string>> = {
  groq: 'groq.com',
  openrouter: 'openrouter.ai',
  nvidia: 'nvidia.com',
  gemini: 'ai.google.dev',
  openai: 'openai.com',
  claude: 'anthropic.com',
  deepseek: 'deepseek.com',
  mistral: 'mistral.ai',
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
export function withKnownMetadata<
  T extends {
    id: string;
    contextWindow: number | undefined;
    vision?: boolean;
    supportsTools?: boolean | undefined;
  },
>(provider: ProviderName, models: readonly T[]): T[] {
  return models.map((m) => {
    const known = knownModel(provider, m.id);
    if (known === undefined) return m;
    return {
      ...m,
      ...(known.contextWindow !== undefined && m.contextWindow === undefined
        ? { contextWindow: known.contextWindow }
        : {}),
      ...(known.vision === true && m.vision === undefined ? { vision: true } : {}),
      ...(known.tools === false ? { supportsTools: false } : {}),
    };
  });
}
