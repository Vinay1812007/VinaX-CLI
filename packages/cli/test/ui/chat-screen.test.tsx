import { createRuntime, type Runtime } from '@vinax/core';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatScreen } from '../../src/ui/components/ChatScreen.js';
import { resolveTheme, ThemeContext } from '../../src/ui/theme.js';
import { createHarness, type Harness } from '../helpers.js';

const mono = resolveTheme('dark', { NO_COLOR: '1' });
const KEYS = {
  enter: '\r',
  shiftEnter: '\x1b[13;2u',
  esc: '\x1b',
  up: '\x1b[A',
  shiftTab: '\x1b[Z',
  ctrlC: '\x03',
  ctrlR: '\x12',
  ctrlO: '\x0f',
  paste: (t: string) => `\x1b[200~${t}\x1b[201~`,
};

let h: Harness | undefined;
let app: ReturnType<typeof render> | undefined;
afterEach(async () => {
  app?.unmount();
  app = undefined;
  await h?.cleanup();
  h = undefined;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await sleep(15);
  }
}

async function mount(
  opts: Parameters<typeof createHarness>[0] = {},
  props: { initialPrompt?: string } = {},
) {
  h = await createHarness(opts);
  const runtime: Runtime = await createRuntime({ cwd: h.cwd, env: h.env });
  const onExit = vi.fn();
  app = render(
    <ThemeContext.Provider value={mono}>
      <ChatScreen runtime={runtime} version="9.9.9" tips={['a tip']} onExit={onExit} {...props} />
    </ThemeContext.Provider>,
  );
  const frame = () => app?.lastFrame() ?? '';
  const type = async (...chunks: string[]) => {
    for (const c of chunks) {
      app?.stdin.write(c);
      await sleep(20);
    }
  };
  await waitFor(() => frame().includes('Ask VinaX anything'), 'prompt box');
  return { frame, type, onExit, harness: h };
}

const lastChatBody = (hh: Harness) => {
  const req = hh.groq.requests.filter((r) => r.path === '/v1/chat/completions').at(-1);
  return req?.body as { messages: { role: string; content: string }[] } | undefined;
};

describe('ChatScreen', () => {
  it('shows the welcome panel and streams a Markdown answer', async () => {
    const { frame, type } = await mount({
      groq: {
        script: {
          'main-model': [
            { text: ['# Hello\n\n', 'Some **bold** text.\n\n', '- one\n- two'], chunkDelayMs: 20 },
          ],
        },
      },
    });
    expect(frame()).toContain('v9.9.9');
    expect(frame()).toContain('main-model via Groq');
    expect(frame()).toContain('a tip');
    await type('hi there', KEYS.enter);
    await waitFor(
      () => frame().includes('• two') && !frame().includes('esc to interrupt'),
      'answer',
    );
    const out = frame();
    expect(out).toContain('› hi there');
    expect(out).toContain('◆ Hello');
    expect(out).toContain('Some bold text.');
    expect(out).toContain('• one');
    expect(out).toContain('groq:main-model');
    expect(out).toMatch(/\d+% context/);
  });

  it('supports multi-line input and collapses large pastes', async () => {
    const { frame, type, harness } = await mount({
      groq: { script: { 'main-model': [{ text: 'ok' }] } },
    });
    await type('line1\\', KEYS.enter, 'line2', KEYS.shiftEnter, 'line3');
    expect(frame()).toContain('› line1');
    expect(frame()).toContain('  line3');
    const big = Array.from({ length: 30 }, (_, i) => `row ${String(i)}`).join('\n');
    await type(' ', KEYS.paste(big));
    expect(frame()).toContain('[Pasted text #1 +30 lines]');
    await type(KEYS.enter);
    await waitFor(() => lastChatBody(harness) !== undefined, 'request');
    expect(lastChatBody(harness)?.messages.at(-1)?.content).toBe(`line1\nline2\nline3 ${big}`);
  });

  it('recalls history with Up and finds it with Ctrl+R', async () => {
    const { frame, type } = await mount({
      groq: { script: { 'main-model': [{ text: 'first answer' }, { text: 'second answer' }] } },
    });
    await type('explain closures', KEYS.enter);
    await waitFor(() => frame().includes('first answer'), 'first answer');
    await type('fix the tests', KEYS.enter);
    await waitFor(() => frame().includes('second answer'), 'second answer');
    await type(KEYS.up);
    expect(frame()).toContain('› fix the tests');
    await type(KEYS.up);
    expect(frame()).toContain('› explain closures');
    await type(KEYS.ctrlC, KEYS.ctrlR, 'fix');
    expect(frame()).toContain('search history: fix');
    expect(frame()).toContain('→ fix the tests');
    await type(KEYS.enter);
    expect(frame()).toContain('› fix the tests');
  });

  it('interrupts with Esc and keeps the partial answer', async () => {
    const { frame, type } = await mount({
      groq: {
        script: {
          'main-model': [
            { text: ['partial words ', 'more ', 'more ', 'more ', 'more '], chunkDelayMs: 250 },
          ],
        },
      },
    });
    await type('go', KEYS.enter);
    await waitFor(() => frame().includes('partial words'), 'partial text');
    expect(frame()).toContain('esc to interrupt');
    await type(KEYS.esc);
    await waitFor(() => frame().includes('Interrupted'), 'interrupt notice');
    expect(frame()).toContain('partial words');
    expect(frame()).not.toContain('esc to interrupt');
  });

  it('falls back to OpenRouter with a visible notice', async () => {
    const { frame, type } = await mount({
      groq: {
        script: {
          'main-model': [
            {
              status: 429,
              headers: { 'retry-after': '90' },
              error: { message: 'Rate limit reached' },
            },
          ],
        },
      },
      openrouter: { script: { 'free-model:free': [{ text: 'from the fallback' }] } },
    });
    await type('hello', KEYS.enter);
    await waitFor(() => frame().includes('from the fallback'), 'fallback answer');
    expect(frame()).toContain(
      'Groq 429: Rate limit reached — switched to openrouter:free-model:free',
    );
    await type(KEYS.ctrlO);
    expect(frame()).toContain('Turn details');
    expect(frame()).toContain('fallback: openrouter:free-model:free');
  });

  it('cycles modes, shows shortcuts, and exits on a double Ctrl+C', async () => {
    const { frame, type, onExit } = await mount();
    expect(frame()).toContain('default mode');
    await type(KEYS.shiftTab);
    expect(frame()).toContain('auto-accept edits');
    await type(KEYS.shiftTab);
    expect(frame()).toContain('plan mode');
    await type('?');
    expect(frame()).toContain('Keyboard shortcuts');
    await type(KEYS.esc);
    expect(frame()).not.toContain('Keyboard shortcuts');
    await type('draft', KEYS.ctrlC);
    expect(frame()).not.toContain('› draft');
    expect(frame()).toContain('Press Ctrl+C again to exit');
    expect(onExit).not.toHaveBeenCalled();
    await type(KEYS.ctrlC);
    expect(onExit).toHaveBeenCalledWith(0);
  });

  it('sends an initial prompt passed on the command line', async () => {
    const { frame } = await mount(
      { groq: { script: { 'main-model': [{ text: 'started' }] } } },
      { initialPrompt: 'kick off' },
    );
    await waitFor(() => frame().includes('started'), 'initial answer');
    expect(frame()).toContain('› kick off');
  });
});
