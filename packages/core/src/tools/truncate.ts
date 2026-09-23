/** Largest tool result sent back to the model (~3.5K tokens; free tiers allow ~8K per minute). */
export const MAX_RESULT_CHARS = 12_000;

/**
 * Keeps the head and tail of long output and says how much was dropped, so the model knows to
 * narrow its request instead of assuming it saw everything.
 */
export function truncateMiddle(text: string, max: number = MAX_RESULT_CHARS, hint = ''): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  const dropped = text.length - head - tail;
  const note = `\n\n[… ${String(dropped)} characters truncated${hint === '' ? '' : ` — ${hint}`} …]\n\n`;
  return text.slice(0, head) + note + text.slice(text.length - tail);
}

export function countLines(text: string): number {
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}
