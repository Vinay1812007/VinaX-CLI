import { SECRET_ENV_VARS } from '../config/secrets.js';
import { ProviderError, providerLabel } from '../providers/errors.js';
import type { ModelRef, ProviderName } from '../providers/types.js';
import { AllModelsFailedError, StreamInterruptedError, type LinkFailure } from './router.js';

/** What kind of problem the user is looking at; decides the advice. */
export type FailureCategory =
  | 'auth'
  | 'no_key'
  | 'rate_limit'
  | 'temporary'
  | 'network'
  | 'unsupported_model'
  | 'too_large'
  | 'tool'
  | 'bad_request'
  | 'unknown';

export interface FailureLine {
  provider: ProviderName;
  model: string;
  category: FailureCategory;
  reason: string;
}

/** A provider failure explained for people: what failed, why, and what to try next. */
export interface FailureReport {
  title: string;
  /** Category of the first (most relevant) failure. */
  category: FailureCategory;
  /** One per model that was tried. */
  lines: FailureLine[];
  /** Set when the failure is not tied to one model. */
  reason?: string;
  actions: string[];
}

export const CATEGORY_LABELS: Record<FailureCategory, string> = {
  auth: 'authentication failed',
  no_key: 'no API key',
  rate_limit: 'rate limited',
  temporary: 'temporary provider error',
  network: 'network error',
  unsupported_model: 'model not available',
  too_large: 'request too large',
  tool: 'tool-call error',
  bad_request: 'request rejected',
  unknown: 'request failed',
};

function categoryOf(kind: LinkFailure['kind']): FailureCategory {
  switch (kind) {
    case 'auth':
      return 'auth';
    case 'no_key':
      return 'no_key';
    case 'rate_limit':
    case 'local_limit':
      return 'rate_limit';
    case 'server':
    case 'timeout':
    case 'unavailable':
      return 'temporary';
    case 'network':
      return 'network';
    case 'not_found':
      return 'unsupported_model';
    case 'too_large':
      return 'too_large';
    case 'tool_format':
      return 'tool';
    case 'bad_request':
      return 'bad_request';
    case 'aborted':
      return 'unknown';
  }
}

function actionsFor(category: FailureCategory, provider: ProviderName | undefined): string[] {
  const label = provider === undefined ? 'provider' : providerLabel(provider);
  const keyHelp =
    provider === undefined
      ? 'add a key with /login'
      : `add or replace the ${label} key with /login (or set ${SECRET_ENV_VARS[provider]})`;
  switch (category) {
    case 'auth':
      return [`check the ${label} key: ${keyHelp}`, 'run /health'];
    case 'no_key':
      return [keyHelp, 'switch to a configured model with /model'];
    case 'rate_limit':
      return ['wait a moment and retry', 'switch model with /model'];
    case 'temporary':
      return ['retry', 'switch model with /model'];
    case 'network':
      return ['check your internet connection', 'run /health'];
    case 'unsupported_model':
      return ['pick an available model with /model or /models'];
    case 'too_large':
      return ['shrink the conversation with /compact', 'switch to a larger-context model'];
    case 'tool':
      return ['retry', 'switch to a model with native tool calling via /model'];
    case 'bad_request':
      return ['retry', 'switch model with /model', 'run /health'];
    case 'unknown':
      return ['retry', 'run /health'];
  }
}

function line(ref: ModelRef, category: FailureCategory, reason: string): FailureLine {
  // drop the "Groq 429:" prefix: the provider is shown separately
  const label = providerLabel(ref.provider);
  const cleaned = reason.startsWith(label)
    ? reason
        .slice(label.length)
        .replace(/^\s*(\d{3})?:?\s*/, (_m, status: string | undefined) =>
          status === undefined ? '' : `HTTP ${status}: `,
        )
    : reason;
  return { provider: ref.provider, model: ref.model, category, reason: cleaned || reason };
}

function unique(list: readonly string[], limit: number): string[] {
  return [...new Set(list)].slice(0, limit);
}

/** Explains an agent or router failure; unknown errors keep their message. */
export function explainError(err: unknown): FailureReport {
  if (err instanceof AllModelsFailedError) {
    if (err.failures.length === 0) {
      return {
        title: 'No models are available',
        category: 'no_key',
        lines: [],
        reason: 'No provider key or model is configured.',
        actions: ['add a key with /login', 'run /health'],
      };
    }
    const lines = err.failures.map((f) => line(f.ref, categoryOf(f.kind), f.reason));
    const first = lines[0];
    return {
      title:
        lines.length === 1 ? 'Provider request failed' : 'Every model in the fallback chain failed',
      category: first?.category ?? 'unknown',
      lines,
      actions: unique(
        lines.flatMap((l) => actionsFor(l.category, l.provider)),
        4,
      ),
    };
  }
  if (err instanceof StreamInterruptedError) {
    const category = categoryOf(err.cause.kind);
    return {
      title: 'The response was cut off',
      category,
      lines: [line(err.ref, category, err.cause.message)],
      actions: unique(['ask again to retry', ...actionsFor(category, err.ref.provider)], 3),
    };
  }
  if (err instanceof ProviderError) {
    const category = categoryOf(err.kind);
    return {
      title: 'Provider request failed',
      category,
      lines: [],
      reason: err.message,
      actions: actionsFor(category, err.provider),
    };
  }
  return {
    title: 'Request failed',
    category: 'unknown',
    lines: [],
    reason: err instanceof Error ? err.message : String(err),
    actions: actionsFor('unknown', undefined),
  };
}

/** Plain-text rendering for print mode and logs. */
export function formatFailureReport(r: FailureReport): string {
  const out = [r.title];
  for (const l of r.lines) {
    out.push(
      `  • ${providerLabel(l.provider)} · ${l.model} — ${CATEGORY_LABELS[l.category]}: ${l.reason}`,
    );
  }
  if (r.reason !== undefined) out.push(`  ${r.reason}`);
  if (r.actions.length > 0) out.push(`  Try: ${r.actions.join(' · ')}`);
  return out.join('\n');
}
