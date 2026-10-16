import { loadSettings, type LoadedSettings } from './config/load.js';
import { cacheDir, logDir, type Env } from './config/paths.js';
import type { Settings } from './config/schema.js';
import { openSecretStore, type SecretStore } from './config/secrets.js';
import { createFileLogger, noopLogger, type Logger } from './log/logger.js';
import { ModelCatalog } from './providers/catalog.js';
import {
  PROBE_CONCURRENCY,
  PROBE_TIMEOUT_MS,
  ProbeCache,
  probeCandidates,
  probeFailed,
  probeModels,
  summarizeProbe,
  type ProbeResult,
} from './providers/probe.js';
import { providerLabel } from './providers/errors.js';
import { findCatalogModel } from './providers/nvidia-free.js';
import { RateLimitLedger } from './providers/ratelimit.js';
import { GATEWAY_WAKING, type GatewayClient } from './providers/gateway.js';
import {
  createGatewayClient,
  createGatewayProvider,
  createProvider,
  createProviders,
  GATEWAY_PROVIDER_NAMES,
} from './providers/registry.js';
import {
  formatModelRef,
  type ModelInfo,
  type Provider,
  type ProviderName,
} from './providers/types.js';
import { Router } from './router/router.js';
import type { SecretName } from './config/secrets.js';

/** One model test of a provider, with the results that are current afterwards. */
export interface ProbeRun {
  provider: ProviderName;
  /** The models a test covers (free chat models and VinaX's known ones). */
  candidates: string[];
  /** The latest result per candidate, from this run or still fresh from an earlier one. */
  results: ProbeResult[];
  /** Models this run actually sent a request to. */
  tested: number;
  /** Candidates that answered. */
  ok: number;
  /** Every model this run tried refused the key. */
  keyRejected: boolean;
  /** Nothing answered and nothing failed for a reason of its own: likely the network. */
  unreachable: boolean;
}

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
  /** Configured model refs left out of routing because their provider's catalog lacks them. */
  skipped: ReadonlySet<string>;
  /** Fresh model-test results per provider, by model id (see {@link Runtime.probeModels}). */
  probes: ReadonlyMap<ProviderName, ReadonlyMap<string, ProbeResult>>;
  /** Refs whose last model test failed; routing leaves them out unless they are asked for. */
  unhealthy: ReadonlySet<string>;
  /** The models a test of this provider covers. */
  probeCandidates(name: ProviderName): string[];
  /** True when some of the provider's candidates have no fresh test result. */
  needsProbe(name: ProviderName): boolean;
  /**
   * Tests the provider's candidates that have no fresh result (all of them with `refresh`), keeps
   * the results on disk and updates {@link Runtime.unhealthy}. Undefined without a usable provider.
   */
  probeModels(
    name: ProviderName,
    opts?: {
      refresh?: boolean;
      signal?: AbortSignal;
      /** Called with `done` 0 before the first request, then after each model. */
      onProgress?: (done: number, total: number) => void;
    },
  ): Promise<ProbeRun | undefined>;
  /** Drops a provider's test results, e.g. because its key changed. */
  forgetProbes(name: ProviderName): Promise<void>;
  /** Uses a new key for a provider right away (after /login). */
  setProviderKey(name: ProviderName, key: string): void;
  /**
   * Re-fetches a provider's model list (after /login or connecting a gateway) and updates
   * which configured models are skipped. Failures keep the previous list.
   */
  refreshCatalog(name: ProviderName, signal?: AbortSignal): Promise<void>;
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
  /** Per-model limit of a model test; default {@link PROBE_TIMEOUT_MS}. */
  probeTimeoutMs?: number;
  probeConcurrency?: number;
}

/**
 * Checks every configured model against its provider's cached `/models` list and returns the
 * ones to skip. Every usable provider's catalog is fetched, in parallel (cached for 24h).
 * An unreachable catalog is not an error: the model is simply tried. A gateway that lists no
 * models for a provider does not serve it, so those refs are skipped without a warning.
 */
async function findUnavailableModels(
  refs: readonly { ref: string; provider: ProviderName; model: string }[],
  providers: ReadonlyMap<ProviderName, Provider>,
  catalog: ModelCatalog,
  timeoutMs: number,
  unreachable: ReadonlySet<ProviderName>,
  viaGateway: ReadonlySet<ProviderName>,
): Promise<{ skip: Set<string>; warnings: string[]; models: Map<ProviderName, ModelInfo[]> }> {
  const skip = new Set<string>();
  const warnings: string[] = [];
  const models = new Map<ProviderName, ModelInfo[]>();
  // every usable provider, not just the configured ones, so the model picker can list them all
  const wanted = [...providers.keys()].filter((name) => !unreachable.has(name));
  await Promise.all(
    wanted.map(async (name) => {
      const provider = providers.get(name);
      if (!provider) return;
      try {
        const result = await catalog.get(provider, { signal: AbortSignal.timeout(timeoutMs) });
        models.set(name, result.models);
      } catch {
        // unknown: try the models anyway
      }
    }),
  );
  for (const { ref, provider: name, model } of refs) {
    const list = models.get(name);
    if (list === undefined || findCatalogModel(name, list, model) !== undefined) continue;
    skip.add(ref);
    if (list.length === 0 && viaGateway.has(name)) continue;
    warnings.push(`${ref} is not in ${providerLabel(name)}'s model list; skipping it.`);
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
  const ledger = new RateLimitLedger();
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
    viaGateway,
  );

  // Last model-test results are only read here (no requests): testing happens on /login,
  // /models and /model, where someone is watching.
  const probeCache = new ProbeCache(cacheDir(env));
  const probes = new Map<ProviderName, Map<string, ProbeResult>>();
  await Promise.all(
    [...providers.keys()].map(async (name) => {
      const loaded = await probeCache.load(name);
      if (loaded.size > 0) probes.set(name, loaded);
    }),
  );
  const unhealthy = new Set<string>();
  const rebuildUnhealthy = (): void => {
    unhealthy.clear();
    for (const [name, results] of probes)
      for (const r of results.values())
        if (probeFailed(r) && probeCache.isFresh(r)) unhealthy.add(`${name}:${r.model}`);
  };
  rebuildUnhealthy();
  for (const r of configured) {
    if (skip.has(r.ref) || !unhealthy.has(r.ref)) continue;
    const result = probes.get(r.provider)?.get(r.model);
    warnings.push(
      `${r.ref} did not answer the last model test${result !== undefined && !result.ok ? ` (${result.reason})` : ''}; skipping it. Run /models test to check again.`,
    );
  }
  const candidatesFor = (name: ProviderName): string[] =>
    probeCandidates(name, models.get(name), { freeOnly: resolved.freeModelsOnly });

  logger.debug('runtime', {
    cwd: opts.cwd,
    providers: [...providers.keys()],
    missingKeys,
    skipped: [...skip],
    unhealthy: [...unhealthy],
    settingsWarnings: settings.warnings,
  });

  let gatewayLink = gateway;
  const useGatewayFor = (name: ProviderName): boolean => {
    if (!gatewayLink || !resolved.providers[name].enabled || !GATEWAY_PROVIDER_NAMES.includes(name))
      return false;
    providers.set(name, createGatewayProvider(name, gatewayLink.client, gatewayLink.token, deps));
    viaGateway.add(name);
    return true;
  };
  return {
    cwd: opts.cwd,
    env,
    probes,
    unhealthy,
    probeCandidates: candidatesFor,
    needsProbe(name) {
      if (!providers.has(name)) return false;
      // a gateway that lists nothing for the provider does not serve it: nothing to test
      if (viaGateway.has(name) && models.get(name)?.length === 0) return false;
      const known = probes.get(name);
      return candidatesFor(name).some((m) => {
        const r = known?.get(m);
        return r === undefined || !probeCache.isFresh(r);
      });
    },
    async probeModels(name, probeOpts = {}) {
      const provider = providers.get(name);
      if (!provider) return undefined;
      const candidates = candidatesFor(name);
      const previous: ReadonlyMap<string, ProbeResult> =
        probeOpts.refresh === true ? new Map() : (probes.get(name) ?? new Map());
      const todo = candidates.filter((m) => {
        const r = previous.get(m);
        return r === undefined || !probeCache.isFresh(r);
      });
      const fresh: ProbeResult[] = [];
      const run = (unreachable: boolean): ProbeRun => {
        const summary = summarizeProbe(fresh);
        const current = new Map(probes.get(name) ?? []);
        // results that were not kept (bad key, no network) are still this run's answer
        for (const r of fresh) current.set(r.model, r);
        const results = candidates
          .map((m) => current.get(m))
          .filter((r): r is ProbeResult => r !== undefined);
        return {
          provider: name,
          candidates,
          results,
          tested: fresh.length,
          ok: results.filter((r) => r.ok).length,
          keyRejected: summary.keyRejected,
          unreachable: unreachable || summary.unreachable,
        };
      };
      // a sleeping gateway would time out every test while it boots, so wake it first
      if (todo.length > 0 && viaGateway.has(name) && gatewayLink && !gatewayLink.client.isAwake()) {
        try {
          await gatewayLink.client.wake(probeOpts.signal);
        } catch (err) {
          if (probeOpts.signal?.aborted === true) throw err;
          return run(true);
        }
      }
      probeOpts.onProgress?.(0, todo.length);
      try {
        await probeModels(provider, todo, {
          timeoutMs: opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS,
          concurrency: opts.probeConcurrency ?? PROBE_CONCURRENCY,
          ...(probeOpts.signal === undefined ? {} : { signal: probeOpts.signal }),
          onResult: (r, done, total) => {
            fresh.push(r);
            probeOpts.onProgress?.(done, total);
          },
        });
      } finally {
        // keep what finished even when the test was cancelled half way, in candidate order
        // (results arrive in completion order, which varies with network speed)
        fresh.sort((a, b) => todo.indexOf(a.model) - todo.indexOf(b.model));
        const summary = summarizeProbe(fresh);
        // a run that only proves the key or the network is bad says nothing about the models
        if (fresh.length > 0 && !summary.keyRejected && !summary.unreachable) {
          const merged = new Map(previous);
          for (const r of fresh) merged.set(r.model, r);
          probes.set(name, merged);
          rebuildUnhealthy();
          await probeCache.save(name, fresh).catch(() => undefined);
        }
      }
      return run(false);
    },
    async forgetProbes(name) {
      probes.delete(name);
      rebuildUnhealthy();
      await probeCache.clear(name).catch(() => undefined);
    },
    async refreshCatalog(name, signal) {
      const provider = providers.get(name);
      if (!provider) return;
      let list: ModelInfo[];
      try {
        list = (
          await catalog.get(provider, {
            refresh: true,
            signal: signal ?? AbortSignal.timeout(opts.catalogTimeoutMs ?? 10_000),
          })
        ).models;
      } catch {
        return;
      }
      models.set(name, list);
      for (const r of configured) {
        if (r.provider !== name) continue;
        // an empty list through a gateway means the gateway does not serve this provider
        const missing =
          list.length > 0
            ? findCatalogModel(name, list, r.model) === undefined
            : viaGateway.has(name);
        if (missing) skip.add(r.ref);
        else skip.delete(r.ref);
      }
    },
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
      for (const name of GATEWAY_PROVIDER_NAMES) if (!providers.has(name)) useGatewayFor(name);
    },
    settings,
    logger,
    secrets,
    ledger,
    providers,
    missingKeys,
    catalog,
    models,
    router: new Router({
      providers,
      ledger,
      settings: resolved,
      logger,
      skip,
      unhealthy,
      models,
    }),
    skipped: skip,
    warnings: [...settings.warnings, ...startupNotes, ...warnings],
  };
}
