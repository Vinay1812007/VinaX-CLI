import { loadSettings, type LoadedSettings } from './config/load.js';
import { cacheDir, logDir, type Env } from './config/paths.js';
import type { Settings } from './config/schema.js';
import { openSecretStore, type SecretStore } from './config/secrets.js';
import { createFileLogger, noopLogger, type Logger } from './log/logger.js';
import { ModelCatalog } from './providers/catalog.js';
import { providerLabel } from './providers/errors.js';
import { RateLimitLedger } from './providers/ratelimit.js';
import { createProviders } from './providers/registry.js';
import {
  formatModelRef,
  type ModelInfo,
  type Provider,
  type ProviderName,
} from './providers/types.js';
import { Router } from './router/router.js';

export interface Runtime {
  cwd: string;
  env: Env;
  settings: LoadedSettings;
  logger: Logger;
  secrets: SecretStore;
  ledger: RateLimitLedger;
  providers: ReadonlyMap<ProviderName, Provider>;
  missingKeys: readonly ProviderName[];
  catalog: ModelCatalog;
  /** Model lists fetched at startup (cached 24h); empty for unreachable providers. */
  models: ReadonlyMap<ProviderName, readonly ModelInfo[]>;
  router: Router;
  /** Non-fatal problems to show the user once (unknown settings, unavailable models, ...). */
  warnings: string[];
}

export interface RuntimeOptions {
  cwd: string;
  env?: Env;
  /** Highest-precedence settings layer, built from CLI flags. */
  cli?: Settings;
  verbose?: boolean;
  /** Model the user asked for explicitly; never skipped even if missing from the catalog. */
  modelOverride?: string;
  catalogTimeoutMs?: number;
}

/**
 * Checks every configured model against its provider's cached `/models` list and returns the
 * ones to skip. An unreachable catalog is not an error: the model is simply tried.
 */
async function findUnavailableModels(
  refs: readonly { ref: string; provider: ProviderName; model: string }[],
  providers: ReadonlyMap<ProviderName, Provider>,
  catalog: ModelCatalog,
  timeoutMs: number,
): Promise<{ skip: Set<string>; warnings: string[]; models: Map<ProviderName, ModelInfo[]> }> {
  const skip = new Set<string>();
  const warnings: string[] = [];
  const known = new Map<ProviderName, Set<string> | undefined>();
  const models = new Map<ProviderName, ModelInfo[]>();
  for (const { ref, provider: name, model } of refs) {
    const provider = providers.get(name);
    if (!provider) continue;
    if (!known.has(name)) {
      try {
        const result = await catalog.get(provider, { signal: AbortSignal.timeout(timeoutMs) });
        known.set(name, new Set(result.models.map((m) => m.id)));
        models.set(name, result.models);
      } catch {
        known.set(name, undefined);
      }
    }
    const ids = known.get(name);
    if (ids && !ids.has(model)) {
      skip.add(ref);
      warnings.push(`${ref} is not in ${providerLabel(name)}'s model list; skipping it.`);
    }
  }
  return { skip, warnings, models };
}

export async function createRuntime(opts: RuntimeOptions): Promise<Runtime> {
  const env = opts.env ?? process.env;
  const settings = await loadSettings({
    cwd: opts.cwd,
    env,
    ...(opts.cli ? { cli: opts.cli } : {}),
  });
  const logger = opts.verbose === true ? createFileLogger(logDir(env)) : noopLogger;
  const secrets = await openSecretStore(env);
  const resolved = settings.resolved;
  const ledger = new RateLimitLedger((p) => resolved.providers[p].rpm);
  const { providers, missingKeys } = await createProviders({
    settings: resolved,
    secrets,
    ledger,
    logger,
  });
  const catalog = new ModelCatalog(cacheDir(env));

  const probe = new Router({ providers, ledger, settings: resolved });
  // The small-model chain already contains the main model and every fallback.
  const configured = probe
    .chain('small')
    .map((r) => ({ ref: formatModelRef(r), ...r }))
    .filter((r) => r.ref !== opts.modelOverride);
  const { skip, warnings, models } = await findUnavailableModels(
    configured,
    providers,
    catalog,
    opts.catalogTimeoutMs ?? 10_000,
  );

  logger.debug('runtime', {
    cwd: opts.cwd,
    providers: [...providers.keys()],
    missingKeys,
    skipped: [...skip],
    settingsWarnings: settings.warnings,
  });

  return {
    cwd: opts.cwd,
    env,
    settings,
    logger,
    secrets,
    ledger,
    providers,
    missingKeys,
    catalog,
    models,
    router: new Router({ providers, ledger, settings: resolved, logger, skip }),
    warnings: [...settings.warnings, ...warnings],
  };
}
