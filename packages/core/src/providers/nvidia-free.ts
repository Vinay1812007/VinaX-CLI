import type { ModelInfo, ProviderName } from './types.js';

/**
 * NVIDIA models with a free hosted endpoint, from build.nvidia.com filtered to "Free Endpoint":
 * https://build.nvidia.com/models?filters=nimType%3Anim_type_preview — update both lists from
 * that page. VinaX lists, tests, routes to and falls back to these NVIDIA models only.
 *
 * The ids are VinaX's best guess at NVIDIA's spelling; matching goes by {@link modelSlug}, so a
 * catalog entry `z-ai/glm-5.3` matches `z-ai/glm-5-3` here, and the catalog's id is what is sent.
 *
 * Chat models, best first: this order is the preference among NVIDIA models in auto mode and
 * pickers. Models with native tool calling for agentic work lead.
 */
export const NVIDIA_FREE_CHAT_MODELS: readonly string[] = [
  'nvidia/nemotron-3-super-120b-a12b',
  'openai/gpt-oss-20b',
  'nvidia/nemotron-3-ultra-550b-a55b',
  'nvidia/nemotron-3.5-super-vl-120b-a12b',
  'meta/muse-glimmer-30b',
  'z-ai/glm-5-3-flash',
  'poolside/laguna-xs-2.1',
  'nvidia/nemotron-3.5-lightning-30b-a3b',
  'stepfun-ai/step-5-preview',
  'deepseek-ai/deepseek-v4.1-flash',
  'google/gemma-4-31b-it',
  'google/diffusiongemma-26b-a4b-it',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
  'nvidia/cosmos3-nano-reasoner',
  'meta/llama-3.2-90b-vision-instruct',
  'meta/llama-3.2-11b-vision-instruct',
  // being retired by NVIDIA, so last
  'z-ai/glm-5-3',
];

/**
 * Free endpoints that are not chat models (speech, embeddings, safety guards, pose, driving,
 * video generation, translation, tabular). Never offered as a model; kept so the free list above
 * plus this one is the whole page.
 */
export const NVIDIA_FREE_OTHER_MODELS: readonly string[] = [
  'Kumo Tabular',
  '3D Body Pose',
  'Kumo Relational',
  'riva-translate-4b-instruct-v2',
  'ising-calibration-1.5-31b',
  'nemotron-3-embed-1b',
  'nemotron-3.5-content-safety',
  'cosmos3-nano',
  'synthetic-video-detector',
  'Active Speaker Detection',
  'ising-calibration-1-35b-a3b',
  'nemotron-voicechat',
  'cosmos-transfer2.5-2b',
  'streampetr',
  'llama-3.1-nemotron-safety-guard-8b-v3',
  'llama-guard-4-12b',
  'Background Noise Removal',
  'magpie-tts-zeroshot',
  'sparsedrive',
  'bevformer',
  'Studio Voice',
  'paligemma',
];

/**
 * A model id without its publisher, lowercased, with `.`, `_` and spaces as `-` and no repeats:
 * `z-ai/GLM-5.3` → `glm-5-3`, `Step 5 Preview` → `step-5-preview`.
 */
export function modelSlug(id: string): string {
  return id
    .slice(id.lastIndexOf('/') + 1)
    .toLowerCase()
    .replace(/[._\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Slugs compared without hyphens too, so `step5-preview` still matches `Step 5 Preview`. */
function matchKey(id: string): string {
  return modelSlug(id).replace(/-/g, '');
}

const RANK = new Map(NVIDIA_FREE_CHAT_MODELS.map((id, i) => [matchKey(id), i]));

/** Position in {@link NVIDIA_FREE_CHAT_MODELS}, or `undefined` for a model not on the list. */
export function nvidiaFreeRank(id: string): number | undefined {
  return RANK.get(matchKey(id));
}

export function isNvidiaFreeChatModel(id: string): boolean {
  return RANK.has(matchKey(id));
}

/** Whether two ids name the same model (same slug, any publisher or punctuation). */
export function sameModel(a: string, b: string): boolean {
  return matchKey(a) === matchKey(b);
}

/**
 * The catalog entry for `model`: the exact id, or for NVIDIA the entry with the same slug (so
 * the catalog's spelling is the one used on the wire).
 */
export function findCatalogModel<T extends { id: string }>(
  provider: ProviderName,
  catalog: readonly T[],
  model: string,
): T | undefined {
  const exact = catalog.find((m) => m.id === model);
  if (exact !== undefined || provider !== 'nvidia') return exact;
  return catalog.find((m) => sameModel(m.id, model));
}

/**
 * NVIDIA's catalog cut down to its free chat models, one entry per model, best first. When
 * nothing in a non-empty catalog matches (the free list has gone stale), the known ids are used.
 * Other providers' catalogs are returned unchanged.
 */
export function restrictToFreeModels(provider: ProviderName, models: ModelInfo[]): ModelInfo[] {
  if (provider !== 'nvidia') return models;
  const bySlug = new Map<number, ModelInfo>();
  for (const m of models) {
    const rank = nvidiaFreeRank(m.id);
    if (rank === undefined) continue;
    const prev = bySlug.get(rank);
    // the publisher VinaX expects wins when NVIDIA lists the same model twice
    if (prev === undefined || m.id === NVIDIA_FREE_CHAT_MODELS[rank]) bySlug.set(rank, m);
  }
  if (bySlug.size === 0 && models.length > 0) {
    return NVIDIA_FREE_CHAT_MODELS.map((id) => ({
      id,
      contextWindow: undefined,
      supportsTools: undefined,
      free: true,
    }));
  }
  return [...bySlug.entries()].sort(([a], [b]) => a - b).map(([, m]) => m);
}
