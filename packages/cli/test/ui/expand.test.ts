import { describe, expect, it } from 'vitest';
import type { ToolDisplay } from '@vinax/core';
import { hiddenLines, nextExpansion } from '../../src/ui/expand.js';
import type { TranscriptItem } from '../../src/ui/transcript.js';

type Diff = Extract<ToolDisplay, { kind: 'diff' }>;

/** A diff of `n` added lines, as one hunk. */
const diff = (n: number): Diff => ({
  kind: 'diff',
  path: 'a.txt',
  created: false,
  added: n,
  removed: 0,
  hunks: [
    {
      lines: Array.from({ length: n }, (_, i) => ({
        kind: 'add' as const,
        text: `line ${String(i + 1)}`,
        newLine: i + 1,
      })),
    },
  ],
});

const tool = (id: number, extra: Partial<Extract<TranscriptItem, { kind: 'tool' }>> = {}) =>
  ({
    id,
    kind: 'tool',
    name: 'Bash',
    label: 'echo',
    ok: true,
    summary: 'ran it',
    display: undefined,
    ...extra,
  }) as TranscriptItem;

describe('hiddenLines', () => {
  it('counts nothing for items that show everything they have', () => {
    expect(hiddenLines({ id: 1, kind: 'user', text: 'hi' })).toBe(0);
    expect(hiddenLines(tool(1))).toBe(0);
    expect(hiddenLines(tool(1, { display: { kind: 'todos', todos: [] }, outputLines: 40 }))).toBe(
      0,
    );
  });

  it('counts a tool output that the one-line summary leaves out', () => {
    expect(hiddenLines(tool(1, { outputLines: 12 }))).toBe(12);
  });

  it('counts only the diff lines past the preview, not the whole diff', () => {
    expect(hiddenLines(tool(1, { display: diff(10) }))).toBe(0);
    expect(hiddenLines(tool(1, { display: diff(30) }))).toBe(6);
  });
});

describe('nextExpansion', () => {
  const outputs = new Map([
    [1, 'one\ntwo\nthree'],
    [3, 'later output'],
  ]);

  it('finds nothing when no tool call is holding anything back', () => {
    expect(nextExpansion([tool(1)], outputs, new Set())).toBeUndefined();
    expect(nextExpansion([], outputs, new Set())).toBeUndefined();
  });

  it('takes the newest call first and then works backwards', () => {
    const items = [tool(1, { outputLines: 3 }), tool(3, { outputLines: 2 })];
    const done = new Set<number>();
    const first = nextExpansion(items, outputs, done);
    expect(first?.id).toBe(3);
    expect(first?.item).toMatchObject({ kind: 'output', title: 'Bash echo', text: 'later output' });
    done.add(3);
    expect(nextExpansion(items, outputs, done)?.id).toBe(1);
    done.add(1);
    expect(nextExpansion(items, outputs, done)).toBeUndefined();
  });

  it('carries the whole diff, which a resumed session still has', () => {
    const next = nextExpansion([tool(7, { display: diff(30) })], new Map(), new Set());
    expect(next?.item).toMatchObject({ kind: 'output', diff: { added: 30 } });
  });

  it('explains itself when the output is from a session that has ended', () => {
    const next = nextExpansion([tool(9, { outputLines: 50 })], new Map(), new Set());
    expect(next?.item).toMatchObject({ kind: 'output' });
    expect((next?.item as { text: string }).text).toContain('only kept for tool calls made since');
  });
});
