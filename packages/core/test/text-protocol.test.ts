import { describe, expect, it } from 'vitest';
import { TextCallParser, toTextProtocol } from '../src/index.js';

function parseInChunks(text: string, cut: (i: number) => boolean) {
  const p = new TextCallParser();
  let visible = '';
  const calls: { name: string; arguments: string }[] = [];
  let buf = '';
  for (let i = 0; i < text.length; i++) {
    buf += text[i] ?? '';
    if (cut(i)) {
      const r = p.push(buf);
      visible += r.text;
      calls.push(...r.calls);
      buf = '';
    }
  }
  const r1 = p.push(buf);
  const r2 = p.flush();
  return { visible: visible + r1.text + r2.text, calls: [...calls, ...r1.calls, ...r2.calls] };
}

const REPLY =
  'Let me look.\n<vx:call name="Read">\n{"file_path": "a.ts"}\n</vx:call>\n<vx:call name="Grep">{"pattern": "x < y"}</vx:call>';

describe('TextCallParser', () => {
  it('extracts calls wherever the stream is split', () => {
    for (let size = 1; size <= 12; size++) {
      const { visible, calls } = parseInChunks(REPLY, (i) => i % size === size - 1);
      expect(visible.trim()).toBe('Let me look.');
      expect(calls).toEqual([
        { name: 'Read', arguments: '{"file_path": "a.ts"}' },
        { name: 'Grep', arguments: '{"pattern": "x < y"}' },
      ]);
    }
  });

  it('streams ordinary text immediately and keeps lone "<" characters', () => {
    const p = new TextCallParser();
    expect(p.push('if a < b then').text).toBe('if a < b then');
    expect(p.push(' <v').text).toBe(' ');
    expect(p.push('ery> ok').text).toBe('<very> ok');
  });

  it('stops at invented tool results and returns unclosed calls on flush', () => {
    const p = new TextCallParser();
    expect(p.push('Done.\n<vx:result name="Read">fake</vx:result> more').text).toBe('Done.\n');
    expect(p.flush()).toEqual({ text: '', calls: [] });
    const q = new TextCallParser();
    q.push('<vx:call name="Bash">{"command": "ls"');
    expect(q.flush().calls).toEqual([{ name: 'Bash', arguments: '{"command": "ls"' }]);
  });
});

describe('toTextProtocol', () => {
  it('turns native tool history into text blocks', () => {
    const out = toTextProtocol([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: 'Checking.',
        toolCalls: [
          { id: '1', name: 'LS', arguments: '{}' },
          { id: '2', name: 'Read', arguments: '{"file_path":"a"}' },
        ],
      },
      { role: 'tool', toolCallId: '1', name: 'LS', content: 'a\nb' },
      { role: 'tool', toolCallId: '2', name: 'Read', content: '1\tx' },
      { role: 'assistant', content: 'All good.' },
    ]);
    expect(out).toEqual([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content:
          'Checking.\n\n<vx:call name="LS">\n{}\n</vx:call>\n<vx:call name="Read">\n{"file_path":"a"}\n</vx:call>',
      },
      {
        role: 'user',
        content:
          '<vx:result name="LS">\na\nb\n</vx:result>\n\n<vx:result name="Read">\n1\tx\n</vx:result>',
      },
      { role: 'assistant', content: 'All good.' },
    ]);
  });
});
