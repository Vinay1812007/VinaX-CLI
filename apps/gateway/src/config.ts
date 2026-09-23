import { parseTokenHashes } from './tokens.js';

export const UPSTREAMS = {
  groq: { baseUrl: 'https://api.groq.com/openai/v1', keyVar: 'GROQ_API_KEY' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', keyVar: 'OPENROUTER_API_KEY' },
} as const;
export type UpstreamName = keyof typeof UPSTREAMS;

export interface Upstream {
  name: UpstreamName;
  baseUrl: string;
  apiKey: string;
}

export interface GatewayConfig {
  port: number;
  /** Upstreams that have an API key. */
  upstreams: Partial<Record<UpstreamName, Upstream>>;
  /** sha256(token) → token name (the name is what gets logged). */
  tokens: ReadonlyMap<string, string>;
  /** Requests per minute and per UTC day allowed for each token. */
  rpm: number;
  rpd: number;
  maxBodyBytes: number;
  /** Tried in order for `"model": "auto"`. */
  defaultModels: readonly string[];
  /** How long to wait for an upstream to start answering. */
  upstreamTimeoutMs: number;
}

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

function int(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new ConfigError(`${name} must be a positive integer`);
  return n;
}

/** Reads the gateway configuration from environment variables (Render's dashboard in production). */
export function loadConfig(env: Env): GatewayConfig {
  const upstreams: Partial<Record<UpstreamName, Upstream>> = {};
  for (const name of Object.keys(UPSTREAMS) as UpstreamName[]) {
    const { baseUrl, keyVar } = UPSTREAMS[name];
    const apiKey = env[keyVar]?.trim();
    if (apiKey === undefined || apiKey === '') continue;
    const override = env[`${name.toUpperCase()}_BASE_URL`]?.trim();
    upstreams[name] = { name, apiKey, baseUrl: (override || baseUrl).replace(/\/$/, '') };
  }
  if (Object.keys(upstreams).length === 0)
    throw new ConfigError('Set GROQ_API_KEY and/or OPENROUTER_API_KEY.');
  let tokens: Map<string, string>;
  try {
    tokens = parseTokenHashes(env.VINAX_TOKEN_HASHES ?? '');
  } catch (err) {
    throw new ConfigError(err instanceof Error ? err.message : String(err));
  }
  if (tokens.size === 0) {
    throw new ConfigError(
      'Set VINAX_TOKEN_HASHES (create a token with: pnpm gateway:token <name>).',
    );
  }
  return {
    port: int(env, 'PORT', 8787),
    upstreams,
    tokens,
    rpm: int(env, 'RATE_LIMIT_RPM', 20),
    rpd: int(env, 'RATE_LIMIT_RPD', 500),
    maxBodyBytes: int(env, 'MAX_BODY_BYTES', 1_000_000),
    defaultModels: (
      env.DEFAULT_MODELS ?? 'groq:openai/gpt-oss-120b,openrouter:qwen/qwen3.8-27b:free'
    )
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== ''),
    upstreamTimeoutMs: int(env, 'UPSTREAM_TIMEOUT_MS', 60_000),
  };
}
