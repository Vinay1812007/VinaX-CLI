import type { Usage } from '../providers/types.js';

/** Tokens one model used: what the provider reported, and what VinaX had to estimate. */
export interface ModelUsage {
  measured: Usage;
  /** For responses the provider sent no usage for (or that were cut off). */
  estimated: Usage;
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
