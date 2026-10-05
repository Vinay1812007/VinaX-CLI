import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { codeBlocks, copyToClipboard } from '../../src/clipboard.js';
import { exitSummaryLines, type ExitSummary } from '../../src/exit-summary.js';
import { SettingsPanel, type SettingRow } from '../../src/ui/components/SettingsPanel.js';
import { SPINNER_FRAMES, Shimmer } from '../../src/ui/components/ActivityIndicator.js';
import * as ed from '../../src/ui/editor.js';
import { resolveTheme, ThemeContext } from '../../src/ui/theme.js';

const mono = resolveTheme('dark', { NO_COLOR: '1' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let app: ReturnType<typeof render> | undefined;
afterEach(() => {
  app?.unmount();
  app = undefined;
});

describe('exit summary', () => {
  const base: ExitSummary = {
    sessionId: '20260929-164512-abc123',
    title: 'Fix login bug',
    prompts: 3,
    toolCalls: 7,
    wallMs: 125_000,
    activeMs: 40_000,
    inputTokens: 45_200,
    outputTokens: 3100,
    filesChanged: 2,
    linesAdded: 12,
    linesRemoved: 4,
    models: ['nvidia:openai/gpt-oss-20b'],
  };

  it('shows the session, how to resume it, time, tokens, changes and models', () => {
    expect(exitSummaryLines(base)).toEqual([
      { label: 'Session', value: '20260929-164512-abc123 · Fix login bug' },
      { label: 'Resume', value: 'vinax --resume 20260929-164512-abc123' },
      { label: 'Time', value: '2m 05s total · 40s working · 3 prompts · 7 tool calls' },
      { label: 'Tokens', value: '45K in · 3.1K out (reported)' },
      { label: 'Changes', value: '2 files · +12 −4 lines' },
      { label: 'Models', value: 'nvidia:openai/gpt-oss-20b' },
    ]);
  });

  it('keeps estimated tokens apart from reported ones and shows the cost only as given', () => {
    const rows = exitSummaryLines({
      ...base,
      estimatedTokens: 2400,
      cost: 'unknown (no price for nvidia:openai/gpt-oss-20b)',
    });
    expect(rows.find((r) => r.label === 'Tokens')?.value).toBe(
      '45K in · 3.1K out (reported) · ~2.4K estimated',
    );
    expect(rows.find((r) => r.label === 'Cost')?.value).toBe(
      'unknown (no price for nvidia:openai/gpt-oss-20b)',
    );
    const onlyEstimated = exitSummaryLines({
      ...base,
      inputTokens: 0,
      outputTokens: 0,
      estimatedTokens: 900,
    });
    expect(onlyEstimated.find((r) => r.label === 'Tokens')?.value).toBe('~900 estimated');
    expect(exitSummaryLines(base).some((r) => r.label === 'Cost')).toBe(false);
  });

  it('says nothing to resume for an empty session', () => {
    expect(exitSummaryLines({ ...base, prompts: 0 })).toEqual([]);
  });
});

describe('copy', () => {
  it('finds fenced code blocks', () => {
    const md = 'Here:\n```ts\nconst a = 1;\n```\ntext\n~~~\nplain\n~~~\n';
    expect(codeBlocks(md)).toEqual([
      { lang: 'ts', code: 'const a = 1;\n' },
      { lang: '', code: 'plain\n' },
    ]);
  });

  it('falls back to the OSC 52 escape when no clipboard program works', async () => {
    const write = vi.fn();
    expect(await copyToClipboard('hi', write, [['definitely-not-a-program-xyz', []]])).toBe(
      'osc52',
    );
    expect(write).toHaveBeenCalledWith(`\x1b]52;c;${Buffer.from('hi').toString('base64')}\x07`);
  });
});

describe('editor', () => {
  it('deletes the word after the cursor and remembers what a kill removed', () => {
    const s = { value: 'git commit --amend', cursor: 4 };
    const after = ed.deleteWordAfter(s);
    expect(after).toEqual({ value: 'git  --amend', cursor: 4 });
    expect(ed.killed(s, after)).toBe('commit');
    const line = ed.fromText('hello world');
    expect(ed.killed(line, ed.killToLineStart(line))).toBe('hello world');
  });
});

describe('animations', () => {
  it('pulses the spinner and sweeps a shimmer across the verb', () => {
    expect(SPINNER_FRAMES).toContain('✻');
    app = render(
      <ThemeContext.Provider value={resolveTheme('dark', {})}>
        <Shimmer text="Thinking…" tick={3} />
      </ThemeContext.Provider>,
    );
    expect(app.lastFrame()).toContain('Thinking…');
  });
});

describe('SettingsPanel', () => {
  const rows: SettingRow[] = [
    { key: 'model', label: 'Model', value: 'groq:x', action: true },
    {
      key: 'effort',
      label: 'Reasoning effort',
      value: 'auto',
      options: ['auto', 'low', 'medium', 'high'],
    },
    { key: 'showTips', label: 'Welcome tips', value: 'on', options: ['on', 'off'] },
  ];

  it('moves with arrows, changes values, saves, and closes with an action', async () => {
    const onChange = vi.fn((_k: string, _v: string) => Promise.resolve(undefined));
    const onClose = vi.fn();
    app = render(
      <ThemeContext.Provider value={mono}>
        <SettingsPanel title="Settings" rows={rows} onChange={onChange} onClose={onClose} />
      </ThemeContext.Provider>,
    );
    const frame = () => app?.lastFrame() ?? '';
    expect(frame()).toContain('❯ Model');
    expect(frame()).toContain('‹ auto ›');
    await sleep(30);
    app.stdin.write('\x1b[B');
    await sleep(20);
    app.stdin.write('\x1b[C');
    await sleep(40);
    expect(onChange).toHaveBeenCalledWith('effort', 'low');
    expect(frame()).toContain('‹ low ›');
    expect(frame()).toContain('✓ Saved Reasoning effort: low');
    app.stdin.write('\x1b[B');
    await sleep(20);
    app.stdin.write(' ');
    await sleep(40);
    expect(onChange).toHaveBeenLastCalledWith('showTips', 'off');
    app.stdin.write('\x1b[A');
    await sleep(20);
    app.stdin.write('\x1b[A');
    await sleep(20);
    app.stdin.write('\r');
    await sleep(20);
    expect(onClose).toHaveBeenCalledWith('model');
  });
});
