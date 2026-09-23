import { loadSettings, type LoadedSettings } from './config/load.js';
import { cacheDir, logDir, type Env } from './config/paths.js';
import type { Settings } from './config/schema.js';
import { openSecretStore, type SecretStore } from './config/secrets.js';
import { createFileLogger, noopLogger, type Logger } from './log/logger.js';
import { ModelCatalog } from './providers/catalog.js';
import { providerLabel } from './providers/errors.js';
import { RateLimitLedger } from './providers/ratelimit.js';
import { GATEWAY_WAKING, type GatewayClient } from './providers/gateway.js';
import {
  createGatewayClient,
  createGatewayProvider,
  createProvider,
  createProviders,
} from './providers/registry.js';
import {
  PROVIDER_NAMES,
  formatModelRef,
  type ModelInfo,
  type Provider,
  type ProviderName,
} from './providers/types.js';
import { Router } from './router/router.js';
import { UsageTracker } from './state/usage.js';
import type { SecretName } from './config/secrets.js';

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
  usage: UsageTracker;
  /** Uses a new key for a provider right away (after /login). */
  setProviderKey(name: ProviderName, key: string): void;
  /** Stops using a provider key, or the gateway (after /logout). */
  removeProvider(name: SecretName): void;
  /** The VinaX gateway, when the user logged in to one. */
  readonly gateway: GatewayClient | undefined;
  /** Providers currently served through the gateway. */
  readonly viaGateway: ReadonlySet<ProviderName>;
  /** Starts using a gateway for every provider without a key of its own (after /login). */
  setGateway(url: string, token: string): void;
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
  unreachable: ReadonlySet<ProviderName>,
): Promise<{ skip: Set<string>; warnings: string[]; models: Map<ProviderName, ModelInfo[]> }> {
  const skip = new Set<string>();
  const warnings: string[] = [];
  const known = new Map<ProviderName, Set<string> | undefined>();
  const models = new Map<ProviderName, ModelInfo[]>();
  for (const { ref, provider: name, model } of refs) {
    const provider = providers.get(name);
    if (!provider || unreachable.has(name)) continue;
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
  const { providers, missingKeys, gateway, viaGateway } = await createProviders({
    settings: resolved,
    secrets,
    ledger,
    logger,
  });
  const deps = { settings: resolved, ledger, logger };
  // A sleeping gateway would stall startup on the model catalog, so check it quickly and let it
  // wake in the background; its models are simply tried until the catalog can be fetched.
  const unreachable = new Set<ProviderName>();
  const startupNotes: string[] = [];
  if (gateway && viaGateway.size > 0) {
    const probe = await gateway.client.probe(2500);
    if (!probe.ok) {
      for (const p of viaGateway) unreachable.add(p);
      startupNotes.push(`${GATEWAY_WAKING}.`);
      gateway.client.wake().catch(() => undefined);
    }
  }
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
    unreachable,
  );

  logger.debug('runtime', {
    cwd: opts.cwd,
    providers: [...providers.keys()],
    missingKeys,
    skipped: [...skip],
    settingsWarnings: settings.warnings,
  });

  const usage = new UsageTracker(env);
  process.once('exit', () => {
    usage.flush();
  });
  let gatewayLink = gateway;
  const useGatewayFor = (name: ProviderName): boolean => {
    if (!gatewayLink || !resolved.providers[name].enabled) return false;
    providers.set(name, createGatewayProvider(name, gatewayLink.client, gatewayLink.token, deps));
    viaGateway.add(name);
    return true;
  };
  return {
    cwd: opts.cwd,
    env,
    usage,
    setProviderKey(name, key) {
      providers.set(name, createProvider(name, key, deps));
      viaGateway.delete(name);
    },
    removeProvider(name) {
      if (name === 'gateway') {
        for (const p of viaGateway) providers.delete(p);
        viaGateway.clear();
        gatewayLink = undefined;
        return;
      }
      providers.delete(name);
      useGatewayFor(name);
    },
    get gateway() {
      return gatewayLink?.client;
    },
    viaGateway,
    setGateway(url, token) {
      for (const p of viaGateway) providers.delete(p);
      viaGateway.clear();
      gatewayLink = { client: createGatewayClient(resolved, url), token };
      for (const name of PROVIDER_NAMES) if (!providers.has(name)) useGatewayFor(name);
    },
    settings,
    logger,
    secrets,
    ledger,
    providers,
    missingKeys,
    catalog,
    models,
    router: new Router({ providers, ledger, settings: resolved, logger, skip, usage }),
    warnings: [...settings.warnings, ...startupNotes, ...warnings],
  };
}
