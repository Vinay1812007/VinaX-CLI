import { MODEL_REF_HINT, PROVIDER_NAMES, type ProviderName } from '../config/schema.js';
import { normalizeModelRef } from './known-models.js';

export { PROVIDER_NAMES, type ProviderName };

/** A tool call as the model produced it; `arguments` is the raw JSON text. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/** An image sent with a user message (base64, no data: prefix). */
export interface ImageAttachment {
  mediaType: ImageMediaType;
  data: string;
  /** File name, for the transcript and for models that cannot see images. */
  name?: string;
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string; images?: ImageAttachment[] }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

/** A tool offered to the model through native (OpenAI-style) function calling. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ModelRef {
  provider: ProviderName;
  model: string;
}

/** Parses `<provider>:<model>`, a provider domain (`nvidia.com:…`) or a model alias. */
export function parseModelRef(ref: string): ModelRef {
  const canonical = normalizeModelRef(ref);
  const idx = canonical?.indexOf(':') ?? -1;
  const provider = canonical?.slice(0, idx) ?? '';
  if (canonical === undefined || !isProviderName(provider)) {
    throw new Error(`Invalid model "${ref}": ${MODEL_REF_HINT}`);
  }
  return { provider, model: canonical.slice(idx + 1) };
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
  /** Accepts images, when the catalog says so (OpenRouter's `input_modalities`). */
  vision?: boolean;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

/** How hard a reasoning model thinks before answering (gpt-oss and similar). */
export const REASONING_EFFORTS = ['low', 'medium', 'high'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export type StreamDelta =
  | { type: 'text'; text: string }
  /** The model's reasoning (not part of the answer), where the provider streams it. */
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call_delta'; index: number; id?: string; name?: string; argsChunk?: string }
  | { type: 'usage'; usage: Usage }
  /** Progress that is not model output, e.g. waiting for the gateway to wake (empty clears it). */
  | { type: 'status'; text: string };

export interface ChatRequest {
  model: string;
  messages: readonly ChatMessage[];
  tools?: readonly ToolSpec[];
  maxTokens?: number;
  /** Sent only when set; providers that reject it get the request again without it. */
  reasoningEffort?: ReasoningEffort;
  signal: AbortSignal;
}

/** `rejected` distinguishes a bad key from a provider that could not be reached. */
export type KeyCheck = { ok: true } | { ok: false; rejected: boolean; reason: string };

export interface Provider {
  readonly name: ProviderName;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  validateKey(signal?: AbortSignal): Promise<KeyCheck>;
  stream(req: ChatRequest): AsyncIterable<StreamDelta>;
  /** Account and quota details, where the provider exposes them (OpenRouter's /key). */
  accountInfo?(signal?: AbortSignal): Promise<Record<string, string> | undefined>;
}
