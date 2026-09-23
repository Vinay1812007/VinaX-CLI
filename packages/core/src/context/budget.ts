import type { ModelCatalog } from '../providers/catalog.js';
import type { RateLimitLedger } from '../providers/ratelimit.js';
import type { ModelRef, Provider, ProviderName } from '../providers/types.js';

/** Used when the catalog does not report a context window. */
const FALLBACK_CONTEXT_WINDOW = 32_768;
/** Share of a tokens-per-minute limit one request may use (it must fit in a single minute). */
const TPM_SHARE = 0.75;

/**
 * The context a request can really use: the model's window, capped by its tokens-per-minute
 * limit when the provider reports one (Groq free tier: ~8K TPM, so ~6K usable).
 */
export async function effectiveContextWindow(
  ref: ModelRef,
  deps: {
    providers: ReadonlyMap<ProviderName, Provider>;
    catalog: ModelCatalog;
    ledger: RateLimitLedger;
  },
): Promise<number> {
  let window = FALLBACK_CONTEXT_WINDOW;
  const provider = deps.providers.get(ref.provider);
  if (provider) {
    try {
      const { models } = await deps.catalog.get(provider);
      window = models.find((m) => m.id === ref.model)?.contextWindow ?? window;
    } catch {
      // keep the fallback
    }
  }
  const tpm = deps.ledger.snapshot(ref.provider, ref.model)?.tokens.limit;
  return tpm === undefined ? window : Math.min(window, Math.floor(tpm * TPM_SHARE));
}
