import { PROVIDER_NAMES, type ProviderName } from '../config/schema.js';

export { PROVIDER_NAMES, type ProviderName };

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string };

export interface ModelRef {
  provider: ProviderName;
  model: string;
}

export function parseModelRef(ref: string): ModelRef {
  const idx = ref.indexOf(':');
  const provider = ref.slice(0, idx);
  const model = ref.slice(idx + 1);
  if (idx <= 0 || model === '' || !isProviderName(provider)) {
    throw new Error(
      `Invalid model "${ref}": expected "<provider>:<model-id>", for example "groq:openai/gpt-oss-120b"`,
    );
  }
  return { provider, model };
}

function isProviderName(value: string): value is ProviderName {
  return (PROVIDER_NAMES as readonly string[]).includes(value);
}

export function formatModelRef(ref: ModelRef): string {
  return `${ref.provider}:${ref.model}`;
}

export interface ModelInfo {
  id: string;
  contextWindow: number | undefined;
  /** `undefined` when the provider's catalog does not say. */
  supportsTools: boolean | undefined;
  free: boolean;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export type StreamDelta = { type: 'text'; text: string } | { type: 'usage'; usage: Usage };

export interface ChatRequest {
  model: string;
  messages: readonly ChatMessage[];
  maxTokens?: number;
  signal: AbortSignal;
}

/** `rejected` distinguishes a bad key from a provider that could not be reached. */
export type KeyCheck = { ok: true } | { ok: false; rejected: boolean; reason: string };

export interface Provider {
  readonly name: ProviderName;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  validateKey(signal?: AbortSignal): Promise<KeyCheck>;
  stream(req: ChatRequest): AsyncIterable<StreamDelta>;
}
