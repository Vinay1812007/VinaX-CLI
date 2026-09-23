import os from 'node:os';
import path from 'node:path';

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

export function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, Math.max(1, max - 1))}…`;
}
