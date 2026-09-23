import { z } from 'zod';

export const PROVIDER_NAMES = ['groq', 'openrouter'] as const;
export const providerNameSchema = z.enum(PROVIDER_NAMES);
export type ProviderName = z.infer<typeof providerNameSchema>;

export const modelRefSchema = z
  .string()
  .regex(
    /^(groq|openrouter):\S+$/,
    'expected "<provider>:<model-id>", for example "groq:openai/gpt-oss-120b"',
  );

export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan'] as const;
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
  providers: z
    .strictObject({
      groq: providerSettingsSchema.optional(),
      openrouter: providerSettingsSchema.optional(),
    })
    .optional(),
  router: routerSettingsSchema.optional(),
  permissions: permissionSettingsSchema.optional(),
  theme: z.enum(THEME_NAMES).optional(),
  /** Input box key bindings. */
  editorMode: z.enum(EDITOR_MODES).optional(),
  hooks: z
    .strictObject(
      Object.fromEntries(
        HOOK_EVENTS.map((e) => [e, z.array(hookMatcherSchema).optional()]),
      ) as Record<HookEvent, z.ZodOptional<z.ZodArray<typeof hookMatcherSchema>>>,
    )
    .optional(),
  disableAllHooks: z.boolean().optional(),
  context: z
    .strictObject({
      /** Conversation size (tokens) VinaX works within; auto-compaction starts at 85% of it. */
      maxTokens: z.number().int().min(4000).optional(),
      autoCompact: z.boolean().optional(),
    })
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
  context: { maxTokens: number; autoCompact: boolean };
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
  ],
  providers: {
    groq: { enabled: true, baseUrl: 'https://api.groq.com/openai/v1', rpm: 30 },
    openrouter: { enabled: true, baseUrl: 'https://openrouter.ai/api/v1', rpm: 20 },
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
  context: { maxTokens: 24_000, autoCompact: true },
  hooks: {},
  disableAllHooks: false,
};

export function resolveSettings(s: Settings): ResolvedSettings {
  const d = DEFAULT_SETTINGS;
  return {
    model: s.model ?? d.model,
    smallModel: s.smallModel ?? d.smallModel,
    fallbackChain: s.fallbackChain ?? d.fallbackChain,
    providers: {
      groq: { ...d.providers.groq, ...s.providers?.groq },
      openrouter: { ...d.providers.openrouter, ...s.providers?.openrouter },
    },
    router: { ...d.router, ...s.router },
    permissions: { ...d.permissions, ...s.permissions },
    theme: s.theme ?? d.theme,
    editorMode: s.editorMode ?? d.editorMode,
    context: { ...d.context, ...s.context },
    hooks: s.hooks ?? {},
    disableAllHooks: s.disableAllHooks ?? false,
  };
}
