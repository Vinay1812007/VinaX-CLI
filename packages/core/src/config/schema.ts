import { z } from 'zod';
import { normalizeModelRef } from '../providers/known-models.js';

export const PROVIDER_NAMES = ['groq', 'openrouter', 'nvidia'] as const;
export const providerNameSchema = z.enum(PROVIDER_NAMES);
export type ProviderName = z.infer<typeof providerNameSchema>;

export const MODEL_REF_HINT = `expected "<provider>:<model-id>" (providers: ${PROVIDER_NAMES.join(', ')}) or a model alias, for example "groq:openai/gpt-oss-120b" or "NVD_CHAT_OSS_20_B"`;

/** A `<provider>:<model>` ref or a model alias; {@link resolveSettings} stores the canonical ref. */
export const modelRefSchema = z
  .string()
  .refine((v) => normalizeModelRef(v) !== undefined, MODEL_REF_HINT);

/**
 * `auto` approves edits, commands and web access inside the project on its own; deny rules, ask
 * rules, dangerous commands and anything outside the project still stop and ask.
 */
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const THEME_NAMES = ['dark', 'light', 'colorblind'] as const;
export type ThemeName = (typeof THEME_NAMES)[number];

export const EDITOR_MODES = ['normal', 'vim'] as const;
export type EditorMode = (typeof EDITOR_MODES)[number];

export const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Stop',
  'SessionStart',
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

const hookCommandSchema = z.strictObject({
  type: z.literal('command'),
  command: z.string().min(1),
  /** Seconds before the hook is stopped (default 60). */
  timeout: z.number().int().positive().max(600).optional(),
});
const hookMatcherSchema = z.strictObject({
  /** Tool name, `A|B` list, or a regular expression (tool events only). */
  matcher: z.string().optional(),
  hooks: z.array(hookCommandSchema).min(1),
});
export type HookMatcher = z.infer<typeof hookMatcherSchema>;

const providerSettingsSchema = z.strictObject({
  enabled: z.boolean().optional(),
  baseUrl: z.url().optional(),
  /** Requests per minute to allow locally before waiting. Mirrors the provider's free-tier RPM. */
  rpm: z.number().int().positive().optional(),
});

const routerSettingsSchema = z.strictObject({
  /** Retries on the same model before moving down the fallback chain. */
  maxRetries: z.number().int().min(0).max(10).optional(),
  baseDelayMs: z.number().int().positive().optional(),
  maxDelayMs: z.number().int().positive().optional(),
  /** Longest wait for a rate-limit window before falling back instead. */
  maxWaitMs: z.number().int().min(0).optional(),
  requestTimeoutMs: z.number().int().positive().optional(),
});

const permissionSettingsSchema = z.strictObject({
  allow: z.array(z.string()).optional(),
  ask: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
  defaultMode: z.enum(PERMISSION_MODES).optional(),
  additionalDirectories: z.array(z.string()).optional(),
});

export const settingsSchema = z.strictObject({
  /** Main model for the agent loop. */
  model: modelRefSchema.optional(),
  /** Cheaper model for titles, summaries and compaction. */
  smallModel: modelRefSchema.optional(),
  /** Tried in order after the main model fails or is rate-limited. */
  fallbackChain: z.array(modelRefSchema).optional(),
  /** Answers prompts that carry images when the main model cannot see them. */
  visionModel: modelRefSchema.optional(),
  providers: z
    .strictObject({
      groq: providerSettingsSchema.optional(),
      openrouter: providerSettingsSchema.optional(),
      nvidia: providerSettingsSchema.optional(),
    })
    .optional(),
  router: routerSettingsSchema.optional(),
  permissions: permissionSettingsSchema.optional(),
  theme: z.enum(THEME_NAMES).optional(),
  /** Input box key bindings. */
  editorMode: z.enum(EDITOR_MODES).optional(),
  /** Reasoning effort for models that support it (gpt-oss): low, medium or high. */
  reasoningEffort: z.enum(['low', 'medium', 'high']).optional(),
  /** Check for new VinaX releases at startup (at most once a day). */
  updateCheck: z.boolean().optional(),
  /** Show tips on the welcome screen. */
  showTips: z.boolean().optional(),
  hooks: z
    .strictObject(
      Object.fromEntries(
        HOOK_EVENTS.map((e) => [e, z.array(hookMatcherSchema).optional()]),
      ) as Record<HookEvent, z.ZodOptional<z.ZodArray<typeof hookMatcherSchema>>>,
    )
    .optional(),
  disableAllHooks: z.boolean().optional(),
  gateway: z
    .strictObject({
      /** An optional VinaX gateway (set by `vinax login --gateway`). */
      url: z.url().optional(),
      /** Longest wait for the gateway to wake up and answer (Render free services sleep). */
      timeoutMs: z.number().int().positive().optional(),
    })
    .optional(),
  context: z
    .strictObject({
      /** Conversation size (tokens) VinaX works within; auto-compaction starts at 85% of it. */
      maxTokens: z.number().int().min(4000).optional(),
      autoCompact: z.boolean().optional(),
    })
    .optional(),
  /** Limits for one task (one prompt and everything VinaX does for it, sub-agents included). */
  budget: z
    .strictObject({
      /** Tokens (input + output, measured or estimated) before VinaX stops and reports. */
      tokens: z.number().int().positive().optional(),
      /** Seconds of work before VinaX stops and reports. */
      seconds: z.number().int().positive().optional(),
    })
    .optional(),
  /**
   * Prices you know, in US dollars per million tokens, by model ref. Costs are only shown for
   * models with explicit prices (from here or the provider's catalog); otherwise "unknown".
   */
  pricing: z
    .record(
      modelRefSchema,
      z.strictObject({
        inputPerMillion: z.number().min(0),
        outputPerMillion: z.number().min(0),
      }),
    )
    .optional(),
});

export type Settings = z.infer<typeof settingsSchema>;

export interface ProviderSettings {
  enabled: boolean;
  baseUrl: string;
  rpm: number;
}

export interface RouterSettings {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  maxWaitMs: number;
  requestTimeoutMs: number;
}

export interface ResolvedSettings {
  model: string;
  smallModel: string;
  fallbackChain: string[];
  visionModel: string | undefined;
  providers: Record<ProviderName, ProviderSettings>;
  router: RouterSettings;
  permissions: {
    allow: string[];
    ask: string[];
    deny: string[];
    defaultMode: PermissionMode;
    additionalDirectories: string[];
  };
  theme: ThemeName;
  editorMode: EditorMode;
  reasoningEffort: 'low' | 'medium' | 'high' | undefined;
  updateCheck: boolean;
  showTips: boolean;
  context: { maxTokens: number; autoCompact: boolean };
  budget: { tokens: number | undefined; seconds: number | undefined };
  /** USD per million tokens, keyed by canonical model ref. */
  pricing: Record<string, { inputPerMillion: number; outputPerMillion: number }>;
  gateway: { url: string | undefined; timeoutMs: number };
  hooks: Partial<Record<HookEvent, HookMatcher[]>>;
  disableAllHooks: boolean;
}

/**
 * Defaults are configuration, not a model list: every ID here is checked against the provider's
 * live `/models` catalog before use, and missing ones are skipped with a warning.
 */
export const DEFAULT_SETTINGS: ResolvedSettings = {
  model: 'groq:openai/gpt-oss-120b',
  smallModel: 'groq:openai/gpt-oss-20b',
  fallbackChain: [
    'groq:qwen/qwen3.8-27b',
    'openrouter:qwen/qwen3.8-27b:free',
    'openrouter:nvidia/nemotron-3-super-120b-a12b:free',
    'nvidia:openai/gpt-oss-20b',
  ],
  visionModel: undefined,
  providers: {
    groq: { enabled: true, baseUrl: 'https://api.groq.com/openai/v1', rpm: 30 },
    openrouter: { enabled: true, baseUrl: 'https://openrouter.ai/api/v1', rpm: 20 },
    // NVIDIA's hosted API (build.nvidia.com); point baseUrl at a self-hosted NIM to use that instead.
    nvidia: { enabled: true, baseUrl: 'https://integrate.api.nvidia.com/v1', rpm: 40 },
  },
  router: {
    maxRetries: 2,
    baseDelayMs: 1_000,
    maxDelayMs: 20_000,
    maxWaitMs: 20_000,
    requestTimeoutMs: 90_000,
  },
  permissions: { allow: [], ask: [], deny: [], defaultMode: 'default', additionalDirectories: [] },
  theme: 'dark',
  editorMode: 'normal',
  reasoningEffort: undefined,
  updateCheck: true,
  showTips: true,
  context: { maxTokens: 24_000, autoCompact: true },
  budget: { tokens: undefined, seconds: undefined },
  pricing: {},
  gateway: { url: undefined, timeoutMs: 120_000 },
  hooks: {},
  disableAllHooks: false,
};

/** Canonical form of a validated model setting (aliases become `<provider>:<model>`). */
function canonical(ref: string): string {
  return normalizeModelRef(ref) ?? ref;
}

export function resolveSettings(s: Settings): ResolvedSettings {
  const d = DEFAULT_SETTINGS;
  return {
    model: canonical(s.model ?? d.model),
    smallModel: canonical(s.smallModel ?? d.smallModel),
    fallbackChain: (s.fallbackChain ?? d.fallbackChain).map(canonical),
    visionModel: s.visionModel === undefined ? d.visionModel : canonical(s.visionModel),
    providers: {
      groq: { ...d.providers.groq, ...s.providers?.groq },
      openrouter: { ...d.providers.openrouter, ...s.providers?.openrouter },
      nvidia: { ...d.providers.nvidia, ...s.providers?.nvidia },
    },
    router: { ...d.router, ...s.router },
    permissions: { ...d.permissions, ...s.permissions },
    theme: s.theme ?? d.theme,
    editorMode: s.editorMode ?? d.editorMode,
    reasoningEffort: s.reasoningEffort ?? d.reasoningEffort,
    updateCheck: s.updateCheck ?? d.updateCheck,
    showTips: s.showTips ?? d.showTips,
    context: { ...d.context, ...s.context },
    budget: {
      tokens: s.budget?.tokens ?? d.budget.tokens,
      seconds: s.budget?.seconds ?? d.budget.seconds,
    },
    pricing: Object.fromEntries(
      Object.entries(s.pricing ?? {}).map(([ref, price]) => [canonical(ref), price]),
    ),
    gateway: {
      url: s.gateway?.url ?? d.gateway.url,
      timeoutMs: s.gateway?.timeoutMs ?? d.gateway.timeoutMs,
    },
    hooks: s.hooks ?? {},
    disableAllHooks: s.disableAllHooks ?? false,
  };
}
