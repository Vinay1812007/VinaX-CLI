import { DIFF_PREVIEW_LINES, diffRows } from './components/DiffView.js';
import type { NewTranscriptItem, TranscriptItem } from './transcript.js';

/** Lines of a finished tool call the transcript does not show, so the entry can offer them. */
export function hiddenLines(item: TranscriptItem): number {
  if (item.kind !== 'tool') return 0;
  // a diff is previewed; everything else is collapsed to its one-line summary
  if (item.display?.kind === 'diff')
    return Math.max(0, diffRows(item.display) - DIFF_PREVIEW_LINES);
  if (item.display !== undefined) return 0;
  return item.outputLines ?? 0;
}

/** Lines of plain tool output an expansion prints before pointing at Ctrl+O for the rest. */
export const EXPAND_MAX_LINES = 400;

const LOST_OUTPUT =
  'The full output is only kept for tool calls made since VinaX started; ask VinaX to run it again to see it.';

/**
 * The newest tool call that still has something to show and has not been expanded yet. Ctrl+X
 * works backwards through the transcript, so pressing it repeatedly opens up older calls.
 */
export function nextExpansion(
  items: readonly TranscriptItem[],
  outputs: ReadonlyMap<number, string>,
  done: ReadonlySet<number>,
): { id: number; item: NewTranscriptItem } | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item === undefined || item.kind !== 'tool') continue;
    if (done.has(item.id) || hiddenLines(item) === 0) continue;
    const title = `${item.name}${item.label === '' ? '' : ` ${item.label}`}`;
    if (item.display?.kind === 'diff')
      return { id: item.id, item: { kind: 'output', title, diff: item.display } };
    const output = outputs.get(item.id) ?? '';
    return {
      id: item.id,
      item: { kind: 'output', title, text: output.trim() === '' ? LOST_OUTPUT : output },
    };
  }
  return undefined;
}
