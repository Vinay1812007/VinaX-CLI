import type { ChatMessage, ToolSpec } from '../providers/types.js';

const CHARS_PER_TOKEN = 3.5;

function chars(m: ChatMessage): number {
  let n = m.content.length;
  if (m.role === 'assistant')
    for (const c of m.toolCalls ?? []) n += c.name.length + c.arguments.length + 16;
  return n;
}

/**
 * Cheap token estimate (~3.5 chars/token plus per-message overhead). It deliberately errs high:
 * it only decides whether a request fits a rate-limit budget or a context window.
 */
export function estimateTokens(
  messages: readonly ChatMessage[],
  tools: readonly ToolSpec[] = [],
): number {
  let total = 3;
  for (const m of messages) total += 4 + Math.ceil(chars(m) / CHARS_PER_TOKEN);
  for (const t of tools) total += 8 + Math.ceil(JSON.stringify(t).length / CHARS_PER_TOKEN);
  return total;
}
