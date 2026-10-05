import os from 'node:os';
import path from 'node:path';
import stringWidth from 'string-width';

export function shortenPath(p: string, home: string = os.homedir()): string {
  const rel = path.relative(home, p);
  if (rel === '') return '~';
  return rel.startsWith('..') || path.isAbsolute(rel) ? p : `~${path.sep}${rel}`;
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * One line of at most `max` terminal columns, ending in "…" when cut. Columns, not string
 * length: CJK characters and most emoji take two, combining marks none.
 */
export function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (stringWidth(oneLine) <= max) return oneLine;
  const room = Math.max(1, max - 1);
  let out = '';
  let used = 0;
  for (const { segment } of graphemes.segment(oneLine)) {
    const w = stringWidth(segment);
    if (used + w > room) break;
    out += segment;
    used += w;
  }
  return `${out}…`;
}

/** `text` padded with spaces to `width` terminal columns (never cut). */
export function padColumns(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - stringWidth(text)));
}

/** "0:07", "1:05:09": a compact running clock for the status line. */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${String(h)}:${String(m).padStart(2, '0')}:${sec}` : `${String(m)}:${sec}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${String(Math.round(n))} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
