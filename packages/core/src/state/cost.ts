import type { ResolvedSettings } from '../config/schema.js';
import {
  parseModelRef,
  type ModelInfo,
  type ProviderName,
  type Usage,
} from '../providers/types.js';

/** Tokens one model used: what the provider reported, and what VinaX had to estimate. */
export interface ModelUsage {
  measured: Usage;
  /** For responses the provider sent no usage for (or that were cut off). */
  estimated: Usage;
}

/** US dollars per token, and where the price came from. */
export interface Price {
  prompt: number;
  completion: number;
  source: 'settings' | 'catalog';
}

export function emptyUsage(): Usage {
  return { promptTokens: 0, completionTokens: 0 };
}

export function addUsage(into: Usage, more: Usage): void {
  into.promptTokens += more.promptTokens;
  into.completionTokens += more.completionTokens;
}

export function totalTokens(u: Usage): number {
  return u.promptTokens + u.completionTokens;
}

/** Adds `more` (by model) into `into`. */
export function mergeModelUsage(
  into: Record<string, ModelUsage>,
  more: Readonly<Record<string, ModelUsage>>,
): void {
  for (const [ref, u] of Object.entries(more)) {
    const slot = (into[ref] ??= { measured: emptyUsage(), estimated: emptyUsage() });
    addUsage(slot.measured, u.measured);
    addUsage(slot.estimated, u.estimated);
  }
}

/**
 * The explicit price of a model: from `pricing` in settings first, then from the provider's
 * catalog when it publishes one. Nothing is guessed: no price means the cost is unknown.
 */
export function priceFor(
  ref: string,
  settings: Pick<ResolvedSettings, 'pricing'>,
  models: ReadonlyMap<ProviderName, readonly ModelInfo[]>,
): Price | undefined {
  const configured = settings.pricing[ref];
  if (configured)
    return {
      prompt: configured.inputPerMillion / 1e6,
      completion: configured.outputPerMillion / 1e6,
      source: 'settings',
    };
  let parsed;
  try {
    parsed = parseModelRef(ref);
  } catch {
    return undefined;
  }
  const info = models.get(parsed.provider)?.find((m) => m.id === parsed.model);
  return info?.pricing === undefined ? undefined : { ...info.pricing, source: 'catalog' };
}

export interface CostEstimate {
  /** Dollars for the priced models; undefined when no model used had a price. */
  usd: number | undefined;
  /** Models with tokens but no explicit price. */
  unpriced: string[];
  /** Part of the priced tokens were estimated, so the cost is approximate. */
  approximate: boolean;
}

export function costOf(
  byModel: Readonly<Record<string, ModelUsage>>,
  price: (ref: string) => Price | undefined,
): CostEstimate {
  let usd: number | undefined;
  const unpriced: string[] = [];
  let approximate = false;
  for (const [ref, u] of Object.entries(byModel)) {
    const tokens = totalTokens(u.measured) + totalTokens(u.estimated);
    if (tokens === 0) continue;
    const p = price(ref);
    if (p === undefined) {
      unpriced.push(ref);
      continue;
    }
    const prompt = u.measured.promptTokens + u.estimated.promptTokens;
    const completion = u.measured.completionTokens + u.estimated.completionTokens;
    usd = (usd ?? 0) + prompt * p.prompt + completion * p.completion;
    if (totalTokens(u.estimated) > 0) approximate = true;
  }
  return { usd, unpriced, approximate };
}

function dollars(n: number): string {
  if (n === 0) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

/** "$0.0123", "≈ $0.0123", "unknown (no price for groq:x)", "$0.0123 + unknown for groq:x". */
export function formatCost(c: CostEstimate): string {
  const unknown =
    c.unpriced.length === 0
      ? ''
      : `unknown${c.usd === undefined ? '' : ' more'} (no price for ${c.unpriced.join(', ')})`;
  if (c.usd === undefined) return unknown === '' ? '$0.00' : unknown;
  const known = `${c.approximate ? '≈ ' : ''}${dollars(c.usd)}`;
  return unknown === '' ? known : `${known} + ${unknown}`;
}
