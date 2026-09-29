import type { SessionSummary } from '@vinax/core';
import type { SelectItem } from './components/Select.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "Today", "Yesterday", "This week" or "Older", by the local calendar. */
export function sessionGroup(updated: Date, now: Date): string {
  const days = Math.round((startOfDay(now) - startOfDay(updated)) / DAY_MS);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'This week';
  return 'Older';
}

/** "just now", "5m ago", "3h ago", "2d ago", or the date for anything older than a month. */
export function relativeTime(then: Date, now: Date): string {
  const s = Math.max(0, Math.floor((now.getTime() - then.getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${String(Math.floor(s / 60))}m ago`;
  if (s < 86_400) return `${String(Math.floor(s / 3600))}h ago`;
  if (s < 30 * 86_400) return `${String(Math.floor(s / 86_400))}d ago`;
  return then.toISOString().slice(0, 10);
}

export function sessionTitle(s: SessionSummary): string {
  const text = s.title ?? s.firstPrompt ?? '(untitled)';
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= 60 ? one : `${one.slice(0, 59)}…`;
}

/** Resume-picker items, most recent first, grouped by day, searchable by title and prompt. */
export function sessionItems(
  sessions: readonly SessionSummary[],
  now: Date = new Date(),
): SelectItem<string>[] {
  return [...sessions]
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .map((s) => ({
      label: sessionTitle(s),
      value: s.id,
      hint: [
        relativeTime(s.updatedAt, now),
        `${String(s.turns)} prompt${s.turns === 1 ? '' : 's'}`,
        ...(s.model === undefined ? [] : [s.model]),
      ].join(' · '),
      group: sessionGroup(s.updatedAt, now),
      keywords: [s.firstPrompt ?? '', s.id],
    }));
}
