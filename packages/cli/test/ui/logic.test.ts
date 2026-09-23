import { stripVTControlCharacters as strip } from 'node:util';
import { describe, expect, it } from 'vitest';
import * as ed from '../../src/ui/editor.js';
import { closeOpenFence, renderMarkdown } from '../../src/ui/markdown.js';
import { PasteStore } from '../../src/ui/paste.js';
import { resolveTheme, THEMES } from '../../src/ui/theme.js';
import { pickTips, TIPS } from '../../src/ui/tips.js';
import { splitStable } from '../../src/ui/transcript.js';

const at = (value: string, cursor: number): ed.EditorState => ({ value, cursor });

describe('editor', () => {
  it('inserts and deletes around the cursor', () => {
    expect(ed.insert(at('ac', 1), 'b')).toEqual(at('abc', 2));
    expect(ed.backspace(at('abc', 2))).toEqual(at('ac', 1));
    expect(ed.backspace(at('abc', 0))).toEqual(at('abc', 0));
    expect(ed.deleteForward(at('abc', 1))).toEqual(at('ac', 1));
  });

  it('moves between lines keeping the column, and reports the edges', () => {
    const s = at('hello\nhi\nworld', 4); // "hell|o"
    const down1 = ed.down(s);
    expect(down1).toEqual(at('hello\nhi\nworld', 8)); // clamped to end of "hi"
    expect(ed.down(at('hello\nhi\nworld', 11))).toBeUndefined();
    expect(ed.up(s)).toBeUndefined();
    expect(ed.up(at('hello\nhi\nworld', 13))).toEqual(at('hello\nhi\nworld', 8));
  });

  it('handles line and word shortcuts', () => {
    const s = at('one two\nthree four', 14); // "three |four"
    expect(ed.lineStart(s).cursor).toBe(8);
    expect(ed.lineEnd(s).cursor).toBe(18);
    expect(ed.deleteWordBack(s)).toEqual(at('one two\nfour', 8));
    expect(ed.killToLineStart(s)).toEqual(at('one two\nfour', 8));
    expect(ed.killToLineEnd(s)).toEqual(at('one two\nthree ', 14));
    expect(ed.killToLineEnd(at('ab\ncd', 2))).toEqual(at('abcd', 2)); // at line end: joins lines
    expect(ed.wordLeft(at('foo bar  ', 9)).cursor).toBe(4);
    expect(ed.wordRight(at('foo bar', 0)).cursor).toBe(3);
  });
});

describe('PasteStore', () => {
  it('keeps small pastes inline and collapses large ones', () => {
    const store = new PasteStore();
    expect(store.add('short\r\ntext')).toBe('short\ntext');
    const big = Array.from({ length: 42 }, (_, i) => `line ${String(i)}`).join('\n');
    const label = store.add(big);
    expect(label).toBe('[Pasted text #1 +42 lines]');
    expect(store.add('x'.repeat(900))).toBe('[Pasted text #2 900 chars]');
    expect(store.expand(`look at ${label} please`)).toBe(`look at ${big} please`);
  });
});

describe('splitStable', () => {
  it('commits complete blocks and keeps the growing tail', () => {
    expect(splitStable('para one\n\npara two is gro')).toEqual({
      stable: 'para one',
      rest: 'para two is gro',
    });
    expect(splitStable('only one para')).toEqual({ stable: '', rest: 'only one para' });
  });

  it('never splits inside a code fence', () => {
    const text = 'intro\n\n```py\na = 1\n\nb = 2\n';
    expect(splitStable(text)).toEqual({ stable: 'intro', rest: '```py\na = 1\n\nb = 2\n' });
    const closed = '```py\na = 1\n\nb = 2\n```\n\nafter';
    expect(splitStable(closed).stable).toBe('```py\na = 1\n\nb = 2\n```');
  });
});

describe('renderMarkdown', () => {
  const mono = resolveTheme('dark', { NO_COLOR: '1' });
  const md = (src: string, width = 40): string => renderMarkdown(src, { width, theme: mono });

  it('renders headings, emphasis, links and nested lists', () => {
    const out = md(
      '# Title\n\nSome **bold** and a [site](https://x.dev).\n\n- a\n  - b\n- [x] done\n\n1. one\n2. two',
    );
    expect(out).toBe(
      [
        'Title',
        '',
        'Some bold and a site (https://x.dev).',
        '',
        '• a',
        '  ◦ b',
        '☑ done',
        '',
        '1. one',
        '2. two',
      ].join('\n'),
    );
  });

  it('keeps code indentation and closes unfinished fences while streaming', () => {
    expect(closeOpenFence('```py\ndef f():')).toBe('```py\ndef f():\n```');
    expect(closeOpenFence('```py\nx\n```')).toBe('```py\nx\n```');
    expect(md('```py\ndef f():\n    return 1')).toBe('╭ py\n│ def f():\n│     return 1');
  });

  it('draws tables that fit the width', () => {
    const out = md('| a | bb |\n|---|---:|\n| x | 12 |', 30);
    expect(out.split('\n')).toEqual([
      '┌─────┬─────┐',
      '│ a   │  bb │',
      '├─────┼─────┤',
      '│ x   │  12 │',
      '└─────┴─────┘',
    ]);
  });

  it('wraps paragraphs to the width and decodes entities', () => {
    const out = md('A & B < C are words in a sentence that needs wrapping here', 20);
    for (const line of out.split('\n')) expect(line.length).toBeLessThanOrEqual(20);
    expect(out.replace(/\n/g, ' ')).toContain('A & B < C');
  });

  it('highlights code when colour is on', () => {
    const out = renderMarkdown('```ts\nconst x = 1;\n```', { width: 40, theme: THEMES.dark });
    expect(out).not.toBe(strip(out));
    expect(strip(out)).toBe('╭ ts\n│ const x = 1;');
  });
});

describe('themes and tips', () => {
  it('NO_COLOR forces the mono theme', () => {
    expect(resolveTheme('light', { NO_COLOR: '1' }).color).toBe(false);
    expect(resolveTheme('light', {}).name).toBe('light');
  });

  it('picks distinct tips', () => {
    const tips = pickTips(3, () => 0);
    expect(new Set(tips).size).toBe(3);
    for (const t of tips) expect(TIPS).toContain(t);
  });
});

describe('typed input filtering', async () => {
  const { cleanTyped, isPrintable } = await import('../../src/ui/keys.js');
  it('accepts text and emoji, rejects control sequences', () => {
    expect(isPrintable('héllo 👋🏽')).toBe(true);
    expect(isPrintable('\x1b[A')).toBe(false);
    expect(isPrintable('')).toBe(false);
    expect(cleanTyped('a\r\nb\tc\x07d 👋🏽')).toBe('a\nbcd 👋🏽');
  });
});
