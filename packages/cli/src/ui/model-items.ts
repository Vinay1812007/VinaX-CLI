import {
  KNOWN_MODELS,
  knownModel,
  parseModelRef,
  PROVIDER_NAMES,
  providerHost,
  providerLabel,
  type ModelInfo,
  type ProviderName,
  type Runtime,
} from '@vinax/core';
import { chatModels } from './components/Onboarding.js';
import type { SelectItem } from './components/Select.js';
import { formatTokens } from './format.js';

/** `no_gateway`: the provider goes through a VinaX gateway that has no key for it. */
export type ModelStatus = 'ready' | 'no_key' | 'no_gateway' | 'unlisted' | 'unchecked';

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
}

/** What the runtime knows about a provider, in picker terms. */
export interface ProviderSummary {
  provider: ProviderName;
  configured: boolean;
  viaGateway: boolean;
  /** `undefined` when the catalog could not be fetched. */
  catalogSize: number | undefined;
}

export function providerSummaries(runtime: Runtime): ProviderSummary[] {
  return PROVIDER_NAMES.map((provider) => ({
    provider,
    configured: runtime.providers.has(provider),
    viaGateway: runtime.viaGateway.has(provider),
    catalogSize: runtime.models.get(provider)?.length,
  }));
}

function row(
  provider: ProviderName,
  info: Pick<ModelInfo, 'id' | 'contextWindow' | 'supportsTools' | 'vision'>,
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
  };
}

/**
 * Every model worth offering, per provider: chat-capable catalog models, VinaX's known models
 * (with aliases) and the current model. Providers with a key come first.
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
      const inCatalog = catalog?.find((m) => m.id === k.model);
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
    out.push(...rows);
  }
  return out;
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
  no_key: 'no key · /login',
  no_gateway: 'add your own key with /login',
};

export function modelHint(r: ModelRow): string {
  return [
    r.alias,
    r.contextWindow === undefined ? undefined : `${formatTokens(r.contextWindow)} ctx`,
    r.vision ? 'vision' : undefined,
    r.supportsTools === false ? 'text tools' : undefined,
    STATUS_HINT[r.status],
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
