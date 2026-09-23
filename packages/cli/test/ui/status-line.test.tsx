import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { StatusLine } from '../../src/ui/components/StatusLine.js';

const line = (width: number, extra: Partial<Parameters<typeof StatusLine>[0]> = {}) =>
  render(
    <StatusLine
      mode="default"
      model="groq:openai/gpt-oss-120b"
      contextPct={5}
      notice={undefined}
      hint={undefined}
      width={width}
      {...extra}
    />,
  ).lastFrame() ?? '';

describe('StatusLine', () => {
  it('shows mode, cycle hint, model and context on a wide terminal', () => {
    const out = line(100);
    expect(out.split('\n')).toHaveLength(1);
    expect(out).toContain('● default mode (shift+tab to cycle)');
    expect(out).toContain('groq:openai/gpt-oss-120b · 5% context');
  });

  it('stays on one line when narrow by dropping the hint, then shortening the model', () => {
    const at70 = line(70);
    expect(at70.split('\n')).toHaveLength(1);
    expect(at70).not.toContain('shift+tab');
    expect(at70).toContain('groq:openai/gpt-oss-120b');
    const at40 = line(40);
    expect(at40.split('\n')).toHaveLength(1);
    expect(at40).toContain('…');
  });

  it('replaces the mode label with a transient hint', () => {
    expect(line(100, { hint: 'Press Ctrl+C again to exit' })).toContain(
      'Press Ctrl+C again to exit',
    );
  });
});
