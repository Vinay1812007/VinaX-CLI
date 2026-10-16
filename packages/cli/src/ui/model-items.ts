import {
  chatModels,
  findCatalogModel,
  formatModelRef,
  freeToTry,
  KNOWN_MODELS,
  knownModel,
  parseModelRef,
  probeFailed,
  probeInconclusive,
  PROVIDER_NAMES,
  providerHost,
  providerLabel,
  type ModelInfo,
  type ProbeRun,
  type ProviderName,
  type Runtime,
} from '@vinax/core';
import type { SelectItem } from './components/Select.js';
import { formatTokens } from './format.js';

/**
 * `no_gateway`: the provider goes through a VinaX gateway that has no key for it. `failed`: the
 * model did not answer its last test (only the current model is listed like that).
 */
export type ModelStatus = 'ready' | 'no_key' | 'no_gateway' | 'unlisted' | 'unchecked' | 'failed';

/**
 * True when a provider is routed through the VinaX gateway but the gateway lists none of its
 * models, i.e. the gateway was not given that provider's key (or predates the provider).
 */
export function gatewayLacks(runtime: Runtime, provider: ProviderName): boolean {
  return runtime.viaGateway.has(provider) && runtime.models.get(provider)?.length === 0;
}

export interface ModelRow {
  ref: string;
  provider: ProviderName;
  model: string;
  alias: string | undefined;
  label: string | undefined;
  contextWindow: number | undefined;
  supportsTools: boolean | undefined;
  /** Accepts images. */
  vision: boolean;
  status: ModelStatus;
  current: boolean;
  pricingHint?: string;
  /** Free outright, or reachable on the provider's free tier. See {@link freeToTry}. */
  free: boolean;
  /** Its last test was rate-limited, so whether it answers is not known yet. */
  untested?: boolean;
  /** Why its last test failed (status `failed`), e.g. "no answer within 20s". */
  failReason?: string;
}

/** What the runtime knows about a provider, in picker terms. */
export interface ProviderSummary {
  provider: ProviderName;
  configured: boolean;
  viaGateway: boolean;
  /** `undefined` when the catalog could not be fetched. */
  catalogSize: number | undefined;
}

/**
 * Configured providers whose models need testing before a list is shown: the ones with untested
 * or expired results, or every one with something to test when `all` is set (`/models test`).
 */
export function providersToTest(runtime: Runtime, all: boolean): ProviderName[] {
  return PROVIDER_NAMES.filter(
    (p) =>
      runtime.providers.has(p) &&
      !gatewayLacks(runtime, p) &&
      (all ? runtime.probeCandidates(p).length > 0 : runtime.needsProbe(p)),
  );
}

/** "12 of 31 answered the last test", from the fresh results of a provider's candidates. */
export function testSummary(runtime: Runtime, provider: ProviderName): string | undefined {
  const results = runtime.probes.get(provider);
  if (results === undefined || results.size === 0) return undefined;
  const candidates = runtime.probeCandidates(provider);
  const tested = candidates.filter((m) => results.has(m));
  if (tested.length === 0) return undefined;
  const ok = tested.filter((m) => results.get(m)?.ok === true).length;
  return `${String(ok)} of ${String(tested.length)} answered the last test`;
}

export function providerSummaries(runtime: Runtime): ProviderSummary[] {
  return PROVIDER_NAMES.map((provider) => ({
    provider,
    configured: runtime.providers.has(provider),
    viaGateway: runtime.viaGateway.has(provider),
    catalogSize: runtime.models.get(provider)?.length,
  }));
}

/**
 * What the picker says a model costs. A catalog price is the only hard evidence either way, so
 * providers whose catalog publishes none get a tier reminder rather than a guess. Groq is left
 * without a hint: its catalog carries no prices and its tier depends on the account.
 */
function pricingHint(
  provider: ProviderName,
  info: Partial<Pick<ModelInfo, 'free' | 'pricing'>>,
): string | undefined {
  if (info.free === true) return 'free';
  if (info.pricing !== undefined) return 'paid';
  switch (provider) {
    case 'gemini':
    case 'mistral':
      return 'free/paid tier · check account';
    case 'openai':
    case 'claude':
    case 'deepseek':
      return 'paid API';
    case 'openrouter':
      return 'pricing unknown';
    default:
      return undefined;
  }
}

function row(
  provider: ProviderName,
  info: Pick<ModelInfo, 'id' | 'contextWindow' | 'supportsTools' | 'vision'> &
    Partial<Pick<ModelInfo, 'free' | 'pricing'>>,
  status: ModelStatus,
  current: string,
): ModelRow {
  const known = knownModel(provider, info.id);
  const ref = `${provider}:${info.id}`;
  return {
    ref,
    provider,
    model: info.id,
    alias: known?.alias,
    label: known?.label,
    contextWindow: info.contextWindow ?? known?.contextWindow,
    supportsTools: info.supportsTools,
    vision: info.vision ?? known?.vision ?? false,
    status,
    current: ref === current,
    free: freeToTry(provider, info),
    ...(() => {
      const hint = pricingHint(provider, info);
      return hint === undefined ? {} : { pricingHint: hint };
    })(),
  };
}

/**
 * Once a provider's models were tested, only the ones that answered are offered. The current
 * model stays (marked when it failed) so the picker always shows where you are, and models whose
 * test was only rate-limited stay too, since that says nothing about them. Without results (the
 * test could not run) the catalog list is all there is.
 */
function testedOnly(runtime: Runtime, provider: ProviderName, rows: ModelRow[]): ModelRow[] {
  const results = runtime.probes.get(provider);
  if (!runtime.providers.has(provider) || results === undefined || results.size === 0) return rows;
  const out: ModelRow[] = [];
  for (const r of rows) {
    const result = results.get(r.model);
    if (result?.ok === true) out.push(r);
    else if (result !== undefined && probeInconclusive(result)) out.push({ ...r, untested: true });
    else if (r.current)
      out.push(
        result !== undefined && r.status === 'ready'
          ? { ...r, status: 'failed', failReason: result.reason }
          : r,
      );
  }
  return out;
}

/**
 * Every model worth offering, per provider: chat-capable catalog models, VinaX's known models
 * (with aliases) and the current model — narrowed to the ones that answered their last test.
 * Providers with a key come first.
 */
export function modelRows(runtime: Runtime, current: string): ModelRow[] {
  const out: ModelRow[] = [];
  const order = [...PROVIDER_NAMES].sort(
    (a, b) => Number(runtime.providers.has(b)) - Number(runtime.providers.has(a)),
  );
  for (const provider of order) {
    const configured = runtime.providers.has(provider);
    const catalog = runtime.models.get(provider);
    const rows: ModelRow[] = [];
    const seen = new Set<string>();
    const add = (r: ModelRow): void => {
      if (seen.has(r.ref)) return;
      seen.add(r.ref);
      rows.push(r);
    };
    const unavailable = (ref: string): boolean => runtime.skipped.has(ref);
    const noGateway = gatewayLacks(runtime, provider);
    for (const k of KNOWN_MODELS.filter((m) => m.provider === provider)) {
      // NVIDIA's spelling of a known id may differ (`glm-5.3` vs `glm-5-3`)
      const inCatalog =
        catalog === undefined ? undefined : findCatalogModel(provider, catalog, k.model);
      // a known model the provider no longer lists is only worth showing if it has an alias
      if (configured && catalog !== undefined && inCatalog === undefined && k.alias === undefined)
        continue;
      const status: ModelStatus = !configured
        ? 'no_key'
        : noGateway
          ? 'no_gateway'
          : catalog === undefined
            ? 'unchecked'
            : inCatalog === undefined || unavailable(`${provider}:${k.model}`)
              ? 'unlisted'
              : 'ready';
      add(
        row(
          provider,
          inCatalog ?? { id: k.model, contextWindow: k.contextWindow, supportsTools: undefined },
          status,
          current,
        ),
      );
    }
    if (configured && catalog !== undefined) {
      for (const m of chatModels(catalog, provider)) {
        const ref = `${provider}:${m.id}`;
        add(row(provider, m, unavailable(ref) ? 'unlisted' : 'ready', current));
      }
    }
    if (!seen.has(current) && parseModelRef(current).provider === provider) {
      const id = parseModelRef(current).model;
      const status: ModelStatus = !configured
        ? 'no_key'
        : noGateway
          ? 'no_gateway'
          : catalog === undefined
            ? 'unchecked'
            : catalog.some((m) => m.id === id) && !unavailable(current)
              ? 'ready'
              : 'unlisted';
      rows.unshift(
        row(
          provider,
          catalog?.find((m) => m.id === id) ?? {
            id,
            contextWindow: undefined,
            supportsTools: undefined,
          },
          status,
          current,
        ),
      );
      seen.add(current);
    }
    out.push(...testedOnly(runtime, provider, rows));
  }
  if (!runtime.settings.resolved.freeModelsOnly) return out;
  // The model in use stays listed even when it is paid, so the picker always shows where you are.
  const free = out.filter((r) => r.free || r.current);
  // Never filter the list down to nothing usable: someone whose only key is a paid API would be
  // left with an empty picker and no way to see why.
  return free.some((r) => r.status === 'ready') ? free : out;
}

export function providerGroupLabel(provider: ProviderName, runtime: Runtime): string {
  const route = gatewayLacks(runtime, provider)
    ? ' · not served by your VinaX gateway'
    : runtime.viaGateway.has(provider)
      ? ' · via VinaX gateway'
      : runtime.providers.has(provider)
        ? ''
        : ' · not configured';
  return `${providerLabel(provider)} · ${providerHost(provider)}${route}`;
}

const STATUS_HINT: Record<ModelStatus, string | undefined> = {
  ready: undefined,
  unchecked: 'catalog unavailable',
  unlisted: 'not in catalog',
  failed: 'did not answer the last test',
  no_key: 'no key · /login',
  no_gateway: 'add your own key with /login',
};

export function modelHint(r: ModelRow): string {
  return [
    r.alias,
    r.pricingHint,
    r.contextWindow === undefined ? undefined : `${formatTokens(r.contextWindow)} ctx`,
    r.vision ? 'vision' : undefined,
    r.supportsTools === false ? 'text tools' : undefined,
    r.untested === true ? 'rate limited during the last test' : undefined,
    r.status === 'failed' && r.failReason !== undefined
      ? `${STATUS_HINT.failed ?? ''} (${r.failReason})`
      : STATUS_HINT[r.status],
  ]
    .filter((p): p is string => p !== undefined)
    .join(' · ');
}

/** Items for the searchable model picker: grouped by provider, unusable models disabled. */
export function modelSelectItems(runtime: Runtime, current: string): SelectItem<string>[] {
  const rows = modelRows(runtime, current);
  const items: SelectItem<string>[] = rows.map((r) => ({
    label: r.model,
    value: r.ref,
    hint: modelHint(r),
    group: providerGroupLabel(r.provider, runtime),
    current: r.current,
    disabled: r.status === 'no_key' || r.status === 'no_gateway' || r.status === 'unlisted',
    keywords: [
      r.ref,
      providerLabel(r.provider),
      providerHost(r.provider),
      ...(r.alias === undefined ? [] : [r.alias]),
      ...(r.label === undefined ? [] : [r.label]),
    ],
  }));
  for (const p of PROVIDER_NAMES) {
    if (runtime.providers.has(p) || rows.some((r) => r.provider === p)) continue;
    items.push({
      label: 'Not configured',
      value: '',
      hint: 'add a key with /login',
      group: providerGroupLabel(p, runtime),
      disabled: true,
      keywords: [providerLabel(p), providerHost(p)],
    });
  }
  return items;
}

/** What to tell the user after a provider's models were tested (nothing when none were). */
export function testSummaryNotice(
  run: ProbeRun,
  freeOnly: boolean,
): { level: 'info' | 'warning' | 'error'; text: string } | undefined {
  const label = providerLabel(run.provider);
  if (run.results.length === 0) return undefined;
  if (run.keyRejected)
    return {
      level: 'error',
      text: `${label} rejected the key for every model it was asked to answer. Check it, and add it again with /login.`,
    };
  if (run.unreachable)
    return {
      level: 'warning',
      text: `Could not reach ${label} to test its models, so its full list is shown. /models test tries again.`,
    };
  const kind = `${freeOnly ? 'free ' : ''}${label} model${run.results.length === 1 ? '' : 's'}`;
  return {
    level: run.ok > 0 ? 'info' : 'warning',
    text: `${String(run.ok)} of ${String(run.results.length)} ${kind} answered${run.ok === 0 ? ', so none are listed' : ''}.`,
  };
}

/**
 * A model to use instead of `current` when its test failed: an answering model of the same
 * provider, VinaX's known (aliased) models first, else the first in the catalog's order.
 */
export function replacementFor(run: ProbeRun, current: string): string | undefined {
  let ref;
  try {
    ref = parseModelRef(current);
  } catch {
    return undefined;
  }
  if (ref.provider !== run.provider) return undefined;
  const mine = run.results.find((r) => r.model === ref.model);
  if (!probeFailed(mine)) return undefined;
  const ok = run.results.filter((r) => r.ok).map((r) => r.model);
  const known = ok.find((m) => knownModel(run.provider, m)?.alias !== undefined);
  const pick = known ?? ok[0];
  return pick === undefined ? undefined : `${run.provider}:${pick}`;
}

/**
 * The model a turn with no model chosen starts with. Usually the configured default, but not
 * when that one is skipped (missing from the catalog, failed its test, or recently timed out).
 */
export function routedDefault(runtime: Runtime): string | undefined {
  try {
    const head = runtime.router.chain('main').find((r) => runtime.providers.has(r.provider));
    return head === undefined ? undefined : formatModelRef(head);
  } catch {
    return undefined;
  }
}
