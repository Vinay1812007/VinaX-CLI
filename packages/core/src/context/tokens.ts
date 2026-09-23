import type { ChatMessage } from '../providers/types.js';

/**
 * Cheap token estimate (~3.5 chars/token plus per-message overhead). It deliberately errs high:
 * it only decides whether a request fits a rate-limit budget or a context window.
 */
export function estimateTokens(messages: readonly ChatMessage[]): number {
  let total = 3;
  for (const m of messages) total += 4 + Math.ceil(m.content.length / 3.5);
  return total;
}
