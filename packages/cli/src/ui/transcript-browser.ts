import { formatFailureReport } from '@vinax/core';
import { formatDuration, formatTokens } from './format.js';
import type { TranscriptItem, TurnRecord } from './transcript.js';

/** One searchable, expandable row of the transcript browser (Ctrl+O). */
export interface BrowseEntry {
  key: string;
  kind: 'prompt' | 'answer' | 'tool' | 'shell' | 'notice' | 'error' | 'panel';
  /** One line for the list. */
  title: string;
  /** Everything there is to see when expanded (and what search looks through). */
  body: string;
  /** For prompts: model, time, tokens, fallbacks. */
  meta?: string;
  tone: 'normal' | 'error' | 'warning' | 'muted';
}

function turnMeta(t: TurnRecord): string {
  return [
    t.model ?? 'no model answered',
    formatDuration(t.durationMs),
    t.inputTokens === undefined
      ? undefined
      : `${formatTokens(t.inputTokens)} in / ${formatTokens(t.outputTokens ?? 0)} out`,
    t.estimatedTokens === undefined ? undefined : `~${formatTokens(t.estimatedTokens)} estimated`,
    t.status === 'done' ? undefined : t.status,
    t.fallbacks.length === 0 ? undefined : `fallback: ${t.fallbacks.join(' → ')}`,
  ]
    .filter((s): s is string => s !== undefined)
    .join(' · ');
}

/**
 * The transcript as browse entries, oldest first. Consecutive answer chunks become one entry,
 * tool calls carry their full output when this session still has it (`outputs`, by item id),
 * and the last prompts are matched with this session's turn records for their details.
 */
export function browseEntries(
  items: readonly TranscriptItem[],
  turns: readonly TurnRecord[],
  outputs: ReadonlyMap<number, string>,
): BrowseEntry[] {
  const out: BrowseEntry[] = [];
  const prompts: BrowseEntry[] = [];
  for (const item of items) {
    switch (item.kind) {
      case 'user': {
        const e: BrowseEntry = {
          key: String(item.id),
          kind: 'prompt',
          title: item.text,
          body: item.text,
          tone: 'normal',
        };
        out.push(e);
        prompts.push(e);
        break;
      }
      case 'assistant': {
        const last = out.at(-1);
        if (last?.kind === 'answer' && !item.first) {
          last.body += `\n\n${item.markdown}`;
        } else
          out.push({
            key: String(item.id),
            kind: 'answer',
            title: item.markdown,
            body: item.markdown,
            tone: 'normal',
          });
        break;
      }
      case 'tool':
        out.push({
          key: String(item.id),
          kind: 'tool',
          title: `${item.name} ${item.label} — ${item.summary}`,
          body:
            outputs.get(item.id) ??
            `${item.summary}\n\n(The full output is only kept for tool calls made since VinaX started; ask VinaX to run it again to see it.)`,
          tone: item.ok ? 'normal' : 'error',
        });
        break;
      case 'shell':
        out.push({
          key: String(item.id),
          kind: 'shell',
          title: `! ${item.command}${item.exitCode === 0 ? '' : ` — exit ${String(item.exitCode ?? '?')}`}`,
          body: item.output === '' ? '(no output)' : item.output,
          tone: item.exitCode === 0 ? 'normal' : 'error',
        });
        break;
      case 'notice':
        out.push({
          key: String(item.id),
          kind: 'notice',
          title: item.text,
          body: item.text,
          tone: item.level === 'error' ? 'error' : item.level === 'warning' ? 'warning' : 'muted',
        });
        break;
      case 'error':
        out.push({
          key: String(item.id),
          kind: 'error',
          title: item.report.title,
          body: formatFailureReport(item.report),
          tone: 'error',
        });
        break;
      case 'panel':
        out.push({
          key: String(item.id),
          kind: 'panel',
          title: item.title,
          body: item.markdown,
          tone: 'muted',
        });
        break;
      case 'welcome':
      case 'summary':
      case 'thought':
        break;
    }
  }
  // this session's turns line up with its last prompts (resumed prompts have no records)
  const offset = prompts.length - turns.length;
  for (const [i, t] of turns.entries()) {
    const p = prompts[offset + i];
    if (p) p.meta = turnMeta(t);
  }
  return out;
}

/** Entries containing every word of `query` (case-insensitive) in their title, body or meta. */
export function searchEntries(entries: readonly BrowseEntry[], query: string): BrowseEntry[] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== '');
  if (words.length === 0) return [...entries];
  return entries.filter((e) => {
    const text = `${e.title}\n${e.body}\n${e.meta ?? ''}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/** The first line of `body` that contains a query word, for showing why an entry matched. */
export function matchLine(entry: BrowseEntry, query: string): string | undefined {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== '');
  if (words.length === 0) return undefined;
  if (words.every((w) => entry.title.toLowerCase().includes(w))) return undefined;
  return entry.body.split('\n').find((l) => words.some((w) => l.toLowerCase().includes(w)));
}
