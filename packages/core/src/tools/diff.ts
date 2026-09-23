import { structuredPatch } from 'diff';
import type { DiffHunk, ToolDisplay } from './types.js';

/** A unified diff (3 lines of context) as display hunks with old/new line numbers. */
export function diffDisplay(
  path: string,
  before: string,
  after: string,
  created: boolean,
): ToolDisplay {
  const patch = structuredPatch(path, path, before, after, '', '', { context: 3 });
  let added = 0;
  let removed = 0;
  const hunks: DiffHunk[] = patch.hunks.map((h) => {
    let oldLine = h.oldStart;
    let newLine = h.newStart;
    const lines: DiffHunk['lines'] = [];
    for (const raw of h.lines) {
      const mark = raw[0];
      const text = raw.slice(1);
      if (mark === '+') {
        added++;
        lines.push({ kind: 'add', text, newLine: newLine++ });
      } else if (mark === '-') {
        removed++;
        lines.push({ kind: 'remove', text, oldLine: oldLine++ });
      } else if (mark === ' ') {
        lines.push({ kind: 'context', text, oldLine: oldLine++, newLine: newLine++ });
      }
      // "\ No newline at end of file" markers are not shown
    }
    return { lines };
  });
  return { kind: 'diff', path, created, added, removed, hunks };
}

export function diffSummary(d: ToolDisplay): string {
  if (d.kind !== 'diff') return '';
  const parts: string[] = [];
  if (d.added > 0) parts.push(`+${String(d.added)}`);
  if (d.removed > 0) parts.push(`−${String(d.removed)}`);
  return parts.length === 0 ? 'no changes' : parts.join(' ');
}
