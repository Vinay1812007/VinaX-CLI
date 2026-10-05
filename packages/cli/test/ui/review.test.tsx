import { Box } from 'ink';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { describe, expect, it } from 'vitest';
import type { FailureReport } from '@vinax/core';
import { changeKind, type ChangeRow } from '../../src/ui/changes.js';
import { ChangesView } from '../../src/ui/components/ChangesView.js';
import { StatusLine } from '../../src/ui/components/StatusLine.js';
import { TranscriptBrowser } from '../../src/ui/components/TranscriptBrowser.js';
import { formatClock, padColumns, truncate } from '../../src/ui/format.js';
import { paletteItems, PALETTE_ACTIONS } from '../../src/ui/palette.js';
import { taskChip } from '../../src/ui/task-state.js';
import { colorDisabled, resolveTheme } from '../../src/ui/theme.js';
import type { SlashCommand } from '../../src/ui/commands/types.js';
import { browseEntries, matchLine, searchEntries } from '../../src/ui/transcript-browser.js';
import type { TranscriptItem, TurnRecord } from '../../src/ui/transcript.js';
import { createHarness } from '../helpers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const widest = (frame: string): number => Math.max(...frame.split('\n').map((l) => stringWidth(l)));

describe('display widths', () => {
  it('truncates by terminal columns, not string length', () => {
    expect(truncate('漢字のテキストです', 9)).toBe('漢字のテ…');
    expect(stringWidth(truncate('漢字のテキストです', 9))).toBeLessThanOrEqual(9);
    expect(truncate('👍🏽👍🏽👍🏽👍🏽', 5)).toBe('👍🏽👍🏽…');
    expect(truncate('ééé', 3)).toBe('ééé');
    expect(truncate('plain   text\nwith lines', 40)).toBe('plain text with lines');
    expect(padColumns('漢字', 6)).toBe('漢字  ');
    expect(formatClock(65_000)).toBe('1:05');
    expect(formatClock(3_725_000)).toBe('1:02:05');
  });
});

describe('terminal capabilities', () => {
  it('treats TERM=dumb like NO_COLOR', () => {
    expect(colorDisabled({ TERM: 'dumb' })).toBe(true);
    expect(colorDisabled({ TERM: 'xterm-256color' })).toBe(false);
    expect(resolveTheme('dark', { TERM: 'dumb' }).color).toBe(false);
  });

  it('refuses the interactive UI on a dumb terminal and points to -p', async () => {
    const h = await createHarness();
    try {
      const { runInteractive } = await import('../../src/interactive.js');
      const err: string[] = [];
      const tty = { isTTY: true, write: () => true };
      const code = await runInteractive(
        {
          prompt: undefined,
          model: undefined,
          verbose: false,
          permissionMode: undefined,
          allowedTools: [],
          disallowedTools: [],
          addDirs: [],
          maxTurns: undefined,
          continueLast: false,
          resume: undefined,
        },
        {
          stdin: tty as never,
          stdout: tty as never,
          stderr: { write: (s: string) => err.push(s) } as never,
          env: { ...h.env, TERM: 'dumb' },
          cwd: h.cwd,
        },
      );
      expect(code).toBe(2);
      expect(err.join('')).toContain('TERM=dumb cannot show the interactive UI');
    } finally {
      await h.cleanup();
    }
  });
});

describe('task state chip', () => {
  it('distinguishes working, waiting, and each way a turn can end', () => {
    expect(taskChip({ kind: 'idle' }, 0, 0)).toBeUndefined();
    expect(taskChip({ kind: 'idle' }, 2, 0)?.text).toBe('2 queued');
    expect(taskChip({ kind: 'running', since: 0 }, 1, 12_000)).toMatchObject({
      text: '● working 0:12 · 1 queued',
      short: '● 0:12',
      tone: 'accent',
    });
    expect(taskChip({ kind: 'waiting', since: 0, what: 'approval', more: 1 }, 0, 3000)?.text).toBe(
      '◆ needs your approval (+1 more) · 0:03',
    );
    expect(
      taskChip({ kind: 'waiting', since: 0, what: 'question', more: 0 }, 0, 0)?.text,
    ).toContain('has a question for you');
    expect(taskChip({ kind: 'ended', status: 'done', durationMs: 8000 }, 0, 0)?.text).toBe(
      '✓ done · 0:08',
    );
    expect(taskChip({ kind: 'ended', status: 'interrupted', durationMs: 0 }, 0, 0)?.tone).toBe(
      'warning',
    );
    expect(taskChip({ kind: 'ended', status: 'failed', durationMs: 0 }, 0, 0)).toMatchObject({
      text: '✖ failed · 0:00',
      tone: 'error',
    });
  });

  it('keeps the status line on one line, shortening the chip on narrow terminals', () => {
    const at = (width: number) =>
      render(
        <StatusLine
          mode="default"
          model="groq:openai/gpt-oss-120b"
          contextPct={5}
          notice={undefined}
          hint={undefined}
          task={{ kind: 'waiting', since: 0, what: 'approval', more: 0 }}
          now={() => 5000}
          width={width}
        />,
      ).lastFrame() ?? '';
    expect(at(120)).toContain('◆ needs your approval · 0:05 · groq:openai/gpt-oss-120b');
    const narrow = at(50);
    expect(narrow.split('\n')).toHaveLength(1);
    expect(narrow).toContain('◆ 0:05');
    expect(widest(at(40))).toBeLessThanOrEqual(40);
  });
});

describe('command palette items', () => {
  const cmd = (name: string, extra: Partial<SlashCommand> = {}): SlashCommand => ({
    name,
    description: `${name} it`,
    source: 'builtin',
    run: () => undefined,
    ...extra,
  });

  it('lists views with their shortcuts, then every command from the registry', () => {
    const items = paletteItems([
      cmd('help'),
      cmd('compact', { argumentHint: '[focus]' }),
      cmd('review', { argumentHint: '<file>', source: 'project' }),
    ]);
    expect(items.slice(0, PALETTE_ACTIONS.length).every((i) => i.group === 'Views')).toBe(true);
    expect(items.find((i) => i.label === 'Review changes')?.hint).toMatch(/^Ctrl\+G · /);
    expect(items.slice(PALETTE_ACTIONS.length).map((i) => [i.label, i.value])).toEqual([
      ['/help', { kind: 'command', name: 'help', needsArgs: false }],
      ['/compact [focus]', { kind: 'command', name: 'compact', needsArgs: false }],
      ['/review <file>', { kind: 'command', name: 'review', needsArgs: true }],
    ]);
    expect(items.at(-1)?.hint).toBe('review it (project)');
  });
});

describe('transcript browser model', () => {
  const report: FailureReport = {
    title: 'Every model failed',
    category: 'network',
    lines: [],
    actions: ['Check your connection'],
  };
  const items: TranscriptItem[] = [
    { id: 0, kind: 'welcome' },
    { id: 1, kind: 'user', text: 'old resumed prompt' },
    { id: 2, kind: 'user', text: 'fix the build' },
    { id: 3, kind: 'assistant', markdown: 'Looking.', first: true },
    {
      id: 4,
      kind: 'tool',
      name: 'Bash',
      label: 'npm run build',
      ok: false,
      summary: 'Exit 1',
      display: undefined,
    },
    { id: 5, kind: 'assistant', markdown: 'The build fails', first: true },
    { id: 6, kind: 'assistant', markdown: 'because of a typo.', first: false },
    { id: 7, kind: 'error', report },
    {
      id: 8,
      kind: 'tool',
      name: 'Read',
      label: 'old.ts',
      ok: true,
      summary: 'Read 3 lines',
      display: undefined,
    },
  ];
  const turns: TurnRecord[] = [
    {
      prompt: 'fix the build',
      model: 'groq:main',
      inputTokens: 1200,
      outputTokens: 80,
      durationMs: 4000,
      fallbacks: ['openrouter:x'],
      tools: [],
      status: 'done',
    },
  ];
  const entries = browseEntries(items, turns, new Map([[4, 'error TS2304: Cannot find name foo']]));

  it('merges answer chunks, keeps full tool output and matches turns to the latest prompts', () => {
    expect(entries.map((e) => e.kind)).toEqual([
      'prompt',
      'prompt',
      'answer',
      'tool',
      'answer',
      'error',
      'tool',
    ]);
    expect(entries[0]?.meta).toBeUndefined();
    expect(entries[1]?.meta).toBe('groq:main · 4s · 1.2K in / 80 out · fallback: openrouter:x');
    expect(entries[4]?.body).toBe('The build fails\n\nbecause of a typo.');
    expect(entries[3]).toMatchObject({ tone: 'error', body: 'error TS2304: Cannot find name foo' });
    expect(entries[5]?.body).toContain('Check your connection');
    expect(entries[6]?.body).toContain('only kept for tool calls made since VinaX started');
  });

  it('searches titles, bodies and turn details, and shows the matching line', () => {
    expect(searchEntries(entries, 'TS2304').map((e) => e.key)).toEqual(['4']);
    expect(searchEntries(entries, 'typo build').map((e) => e.key)).toEqual(['5']);
    expect(searchEntries(entries, 'openrouter').map((e) => e.key)).toEqual(['2']);
    const hit = entries.find((e) => e.key === '4');
    expect(hit && matchLine(hit, 'cannot find')).toBe('error TS2304: Cannot find name foo');
    expect(hit && matchLine(hit, 'npm')).toBeUndefined();
  });

  it('renders within a narrow terminal and handles an empty transcript', async () => {
    const narrow = render(
      <Box width={40}>
        <TranscriptBrowser
          entries={entries}
          limits={[]}
          width={40}
          height={20}
          onClose={() => undefined}
        />
      </Box>,
    );
    expect(widest(narrow.lastFrame() ?? '')).toBeLessThanOrEqual(40);
    const empty = render(
      <TranscriptBrowser
        entries={[]}
        limits={[]}
        width={60}
        height={20}
        onClose={() => undefined}
      />,
    );
    expect(empty.lastFrame()).toContain('Nothing here yet');
    await sleep(30);
    empty.stdin.write('/');
    await sleep(30);
    empty.stdin.write('zzz');
    await sleep(30);
    expect(empty.lastFrame()).toContain('0 of 0');
  });
});

describe('changes view', () => {
  const row = (file: string, extra: Partial<ChangeRow> = {}): ChangeRow => ({
    file: `/p/${file}`,
    shown: file,
    firstTurn: 1,
    kind: 'modified',
    status: 'clean',
    reason: undefined,
    added: 1,
    removed: 1,
    original: 'a\nb\n',
    current: 'a\nB\n',
    ...extra,
  });

  it('classifies changes against the original', () => {
    expect(changeKind(null, 'x')).toBe('created');
    expect(changeKind('x', null)).toBe('deleted');
    expect(changeKind('x', 'y')).toBe('modified');
    expect(changeKind('x', 'x')).toBe('unchanged');
    expect(changeKind('x', undefined)).toBe('unreadable');
  });

  it('fits a narrow terminal, with long and wide file names', async () => {
    const rows = [
      row('src/some/very/deeply/nested/folder/component-name.tsx'),
      row('docs/漢字のファイル名.md', {
        status: 'modified',
        reason: 'edited since VinaX changed it',
      }),
    ];
    const r = render(
      <Box width={40}>
        <ChangesView
          load={() => Promise.resolve(rows)}
          undo={() => Promise.resolve('')}
          width={40}
          height={24}
          onClose={() => undefined}
        />
      </Box>,
    );
    await sleep(50);
    const frame = r.lastFrame() ?? '';
    expect(frame).toContain('Changes this session');
    expect(frame).toContain('- b');
    expect(widest(frame)).toBeLessThanOrEqual(40);
  });
});

describe('turn outcomes', () => {
  it('maps every way a turn can end to what the user sees', async () => {
    const { outcomeItem } = await import('../../src/ui/turn-events.js');
    const base = {
      text: 'ok',
      steps: 2,
      usage: { promptTokens: 0, completionTokens: 0 },
      estimatedUsage: { promptTokens: 0, completionTokens: 0 },
      usageByModel: {},
      models: [],
    };
    expect(outcomeItem({ ...base, status: 'done' })).toBeUndefined();
    expect(outcomeItem({ ...base, status: 'done', steps: 1, text: ' ' })).toMatchObject({
      text: 'The model returned an empty answer.',
    });
    expect(outcomeItem({ ...base, status: 'interrupted' })).toMatchObject({ level: 'warning' });
    expect(
      outcomeItem({ ...base, status: 'budget', error: 'Stopped at the token budget' }),
    ).toMatchObject({
      level: 'warning',
      text: 'Stopped at the token budget',
    });
    expect(outcomeItem({ ...base, status: 'stuck', error: 'Stopped: x' })).toMatchObject({
      text: 'Stopped: x',
    });
    expect(outcomeItem({ ...base, status: 'failed', error: 'boom' })).toMatchObject({
      level: 'error',
      text: 'boom',
    });
    expect(outcomeItem({ ...base, status: 'declined' })?.kind).toBe('notice');
  });
});
