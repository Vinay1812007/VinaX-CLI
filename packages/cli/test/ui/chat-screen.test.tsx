import fs from 'node:fs/promises';
import path from 'node:path';
import { createRuntime, type AgentSetup, type Runtime } from '@vinax/core';
import { openSession } from '../../src/session.js';
import { loadCommands } from '../../src/ui/commands/registry.js';
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
  setup?.shell.killAll();
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

let setup: AgentSetup | undefined;

async function mount(
  opts: Parameters<typeof createHarness>[0] & { files?: Record<string, string> } = {},
  props: { initialPrompt?: string } = {},
) {
  h = await createHarness(opts);
  for (const [rel, text] of Object.entries(opts.files ?? {})) {
    await fs.mkdir(path.dirname(path.join(h.cwd, rel)), { recursive: true });
    await fs.writeFile(path.join(h.cwd, rel), text);
  }
  const runtime: Runtime = await createRuntime({
    cwd: h.cwd,
    env: { ...h.env, PATH: process.env.PATH },
  });
  const opened = await openSession(runtime, { kind: 'new' }, {});
  setup = opened.setup;
  const { commands } = await loadCommands(runtime);
  const onExit = vi.fn();
  const onClear = vi.fn();
  const onResume = vi.fn();
  app = render(
    <ThemeContext.Provider value={mono}>
      <ChatScreen
        runtime={runtime}
        setup={setup}
        session={opened.writer}
        commands={commands}
        editorMode="normal"
        onClear={onClear}
        onResume={onResume}
        onTheme={() => undefined}
        version="9.9.9"
        tips={['a tip']}
        onExit={onExit}
        {...props}
      />
    </ThemeContext.Provider>,
  );
  const frame = () => app?.lastFrame() ?? '';
  const type = async (...chunks: string[]) => {
    // Ink subscribes to input after drawing a new screen; give it a moment like a real user would.
    await sleep(60);
    for (const c of chunks) {
      app?.stdin.write(c);
      await sleep(20);
    }
  };
  await waitFor(() => frame().includes('Ask VinaX anything'), 'prompt box');
  const cwd = h.cwd;
  const read = (rel: string) => fs.readFile(path.join(cwd, rel), 'utf8');
  return {
    frame,
    type,
    onExit,
    onClear,
    onResume,
    harness: h,
    read,
    runtime,
    setup: opened.setup,
    writer: opened.writer,
  };
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

const call = (name: string, args: Record<string, unknown>) => ({
  name,
  arguments: JSON.stringify(args),
});
const reqBodies = (hh: Harness) =>
  hh.groq.requests
    .filter((r) => r.path === '/v1/chat/completions')
    .map((r) => r.body as { messages: { role: string; content: string | null }[] });

describe('ChatScreen agent', () => {
  it('shows tool calls as tree lines and runs reads without asking', async () => {
    const { frame, type } = await mount({
      files: { 'notes.txt': 'one\ntwo\n' },
      groq: {
        script: {
          'main-model': [
            { toolCalls: [call('Read', { file_path: 'notes.txt' })] },
            { text: 'It has two lines.' },
          ],
        },
      },
    });
    await type('read notes', KEYS.enter);
    await waitFor(() => frame().includes('It has two lines.'), 'answer');
    expect(frame()).toContain('▸ Read notes.txt');
    expect(frame()).toContain('└ Read 2 lines');
  });

  it('asks before an edit, shows the diff, and applies it on Yes', async () => {
    const { frame, type, read } = await mount({
      files: { 'a.txt': 'hello world\n' },
      groq: {
        script: {
          'main-model': [
            { toolCalls: [call('Read', { file_path: 'a.txt' })] },
            {
              toolCalls: [
                call('Edit', { file_path: 'a.txt', old_string: 'world', new_string: 'VinaX' }),
              ],
            },
            { text: 'Done.' },
          ],
        },
      },
    });
    await type('greet vinax', KEYS.enter);
    await waitFor(() => frame().includes('Edit a.txt?'), 'permission prompt');
    const promptFrame = frame();
    expect(promptFrame).toContain('- hello world');
    expect(promptFrame).toContain('+ hello VinaX');
    expect(promptFrame).toContain('Yes, and auto-accept edits');
    expect(promptFrame).toContain("Yes, and don't ask again for Edit(**) this session");
    expect(promptFrame).not.toContain('Ask VinaX anything');
    await type('1');
    await waitFor(() => frame().includes('Done.'), 'answer');
    expect(await read('a.txt')).toBe('hello VinaX\n');
    expect(frame()).toContain('└ Changed +1 −1 lines');
  });

  it('takes "No" with feedback and passes it to the model', async () => {
    const { frame, type, harness } = await mount({
      groq: {
        script: {
          'main-model': [
            { toolCalls: [call('Bash', { command: 'npm test' })] },
            { text: 'OK, using pnpm.' },
          ],
        },
      },
    });
    await type('run tests', KEYS.enter);
    await waitFor(() => frame().includes('Run this command?'), 'command prompt');
    expect(frame()).toContain('npm test');
    await type('4');
    await waitFor(() => frame().includes('What should VinaX do instead?'), 'feedback input');
    await type('use pnpm', KEYS.enter);
    await waitFor(() => frame().includes('OK, using pnpm.'), 'answer');
    expect(reqBodies(harness).at(-1)?.messages.at(-1)).toEqual({
      role: 'user',
      content: 'I declined that action. Instead: use pnpm',
    });
  });

  it('remembers "don\'t ask again" for the session', async () => {
    const { frame, type } = await mount({
      groq: {
        script: {
          'main-model': [
            { toolCalls: [call('Bash', { command: 'echo first' })] },
            { text: 'one' },
            { toolCalls: [call('Bash', { command: 'echo second' })] },
            { text: 'two' },
          ],
        },
      },
    });
    await type('go', KEYS.enter);
    await waitFor(() => frame().includes('Run this command?'), 'prompt');
    await type('2');
    await waitFor(() => frame().includes('◆ one'), 'first answer');
    await type('again', KEYS.enter);
    await waitFor(() => frame().includes('◆ two'), 'second answer without asking');
    expect(frame()).toContain('└ Exit 0 · 1 line');
  });

  it('warns about dangerous commands and offers no blanket approval', async () => {
    const { frame, type } = await mount({
      groq: {
        script: {
          'main-model': [
            { toolCalls: [call('Bash', { command: 'rm -rf build' })] },
            { text: 'skipped' },
          ],
        },
      },
    });
    await type('clean', KEYS.enter);
    await waitFor(() => frame().includes('Run this command?'), 'prompt');
    expect(frame()).toContain('⚠ This deletes files recursively without confirmation (rm -rf)');
    expect(frame()).not.toContain("don't ask again");
    await type(KEYS.esc);
    await waitFor(() => frame().includes('Stopped: you declined'), 'declined notice');
  });

  it('shows the live task list', async () => {
    const todos = [
      { content: 'Read the code', status: 'completed' },
      { content: 'Fix the bug', status: 'in_progress', activeForm: 'Fixing the bug' },
      { content: 'Run tests', status: 'pending' },
    ];
    const { frame, type } = await mount({
      groq: {
        script: {
          'main-model': [
            { toolCalls: [call('TodoWrite', { todos })] },
            { text: 'Working.', chunkDelayMs: 50 },
          ],
        },
      },
    });
    await type('plan work', KEYS.enter);
    await waitFor(() => frame().includes('Working.'), 'answer');
    expect(frame()).toContain('Tasks');
    expect(frame()).toContain('☑ Read the code');
    expect(frame()).toContain('◐ Fixing the bug');
    expect(frame()).toContain('☐ Run tests');
  });

  it('asks for plan approval in plan mode and switches to auto-accept', async () => {
    const { frame, type, harness } = await mount({
      groq: {
        script: {
          'main-model': [
            { toolCalls: [call('ExitPlanMode', { plan: '1. Change **a.txt**\n2. Run tests' })] },
            { text: 'Starting now.' },
          ],
        },
      },
    });
    await type(KEYS.shiftTab, KEYS.shiftTab);
    expect(frame()).toContain('plan mode');
    await type('make a plan', KEYS.enter);
    await waitFor(() => frame().includes('Go ahead with this plan?'), 'plan prompt');
    expect(frame()).toContain('1. Change a.txt');
    await type('1');
    await waitFor(() => frame().includes('Starting now.'), 'answer');
    expect(frame()).toContain('auto-accept edits');
    const first = harness.groq.requests.find((r) => r.path === '/v1/chat/completions')?.body as {
      tools: { function: { name: string } }[];
    };
    expect(first.tools.map((t) => t.function.name)).not.toContain('Edit');
  });

  it('rewinds the conversation and restores files with Esc Esc', async () => {
    const { frame, type, read } = await mount({
      files: { 'a.txt': 'original\n' },
      groq: {
        script: {
          'main-model': [
            { toolCalls: [call('Read', { file_path: 'a.txt' })] },
            { toolCalls: [call('Write', { file_path: 'a.txt', content: 'rewritten\n' })] },
            { text: 'Rewrote it.' },
          ],
        },
      },
    });
    await type('rewrite a.txt', KEYS.enter);
    await waitFor(
      () => frame().includes('Write a.txt') || frame().includes('Edit a.txt?'),
      'prompt',
    );
    await type('1');
    await waitFor(() => frame().includes('Rewrote it.'), 'answer');
    expect(await read('a.txt')).toBe('rewritten\n');
    await type(KEYS.esc, KEYS.esc);
    await waitFor(() => frame().includes('Rewind to before which prompt?'), 'rewind picker');
    expect(frame()).toContain('1 file changed since');
    await type(KEYS.enter);
    await waitFor(
      () => frame().includes('Restore the conversation and 1 changed file(s)'),
      'restore options',
    );
    await type(KEYS.enter);
    await waitFor(() => frame().includes('Rewound the conversation and 1 file'), 'rewound');
    expect(await read('a.txt')).toBe('original\n');
    expect(frame()).toContain('› rewrite a.txt');
  });
});

describe('ChatScreen workflow (M4)', () => {
  const TAB = '\t';
  const lastRequest = (hh: Harness) =>
    hh.groq.requests.filter((r) => r.path === '/v1/chat/completions').at(-1)?.body as
      { model: string; messages: { role: string; content: string }[] } | undefined;

  it('offers / completions and runs /help', async () => {
    const { frame, type } = await mount();
    await type('/he');
    await waitFor(() => frame().includes('/help'), 'menu');
    expect(frame()).toContain('Show commands and keyboard shortcuts');
    await type(KEYS.enter);
    await waitFor(() => frame().includes('VinaX help'), 'help panel');
    expect(frame()).toContain('/compact [focus]');
    await type('/nope', KEYS.esc, KEYS.enter);
    await waitFor(() => frame().includes('Unknown command /nope'), 'unknown notice');
  });

  it('runs custom commands with arguments and allowed tools', async () => {
    const { frame, type, harness } = await mount({
      files: {
        '.vinax/commands/review.md':
          '---\ndescription: Review a file\nargument-hint: <file>\n---\nReview $1 carefully.',
      },
      groq: { script: { 'main-model': [{ text: 'Reviewed.' }] } },
    });
    await type('/rev');
    await waitFor(() => frame().includes('Review a file (project)'), 'custom command in menu');
    await type(TAB, 'src/a.ts', KEYS.enter);
    await waitFor(() => frame().includes('Reviewed.'), 'answer');
    expect(frame()).toContain('› /review src/a.ts');
    expect(lastRequest(harness)?.messages.at(-1)?.content).toBe('Review src/a.ts carefully.');
  });

  it('attaches @files chosen from the completion menu', async () => {
    const { frame, type, harness } = await mount({
      files: { 'src/app.ts': 'export const answer = 42;\n' },
      groq: { script: { 'main-model': [{ text: 'It exports answer.' }] } },
    });
    await type('what is in @ap');
    await waitFor(() => frame().includes('@src/app.ts'), 'file suggestion');
    await type(TAB);
    expect(frame()).toContain('› what is in @src/app.ts');
    await type(KEYS.enter);
    await waitFor(() => frame().includes('It exports answer.'), 'answer');
    const sent = lastRequest(harness)?.messages.at(-1)?.content ?? '';
    expect(sent).toContain('<file path="src/app.ts">\n     1\texport const answer = 42;');
  });

  it('runs ! commands directly and shares their output with the model', async () => {
    const { frame, type, harness } = await mount({
      groq: { script: { 'main-model': [{ text: 'I see hello.' }] } },
    });
    await type('!echo hello-from-shell');
    expect(frame()).toContain('! shell command');
    await type(KEYS.enter);
    await waitFor(() => frame().includes('! echo hello-from-shell'), 'shell entry');
    expect(frame()).toContain('hello-from-shell');
    await type('what did it print?', KEYS.enter);
    await waitFor(() => frame().includes('I see hello.'), 'answer');
    const msgs = lastRequest(harness)?.messages ?? [];
    expect(msgs.at(-2)?.content).toContain('<shell-output exit-code="0">\nhello-from-shell');
  });

  it('saves # notes to project memory and uses them', async () => {
    const { frame, type, harness, read } = await mount({
      groq: { script: { 'main-model': [{ text: 'Noted.' }] } },
    });
    await type('#always use tabs', KEYS.enter);
    await waitFor(() => frame().includes('Save this note to which memory?'), 'memory picker');
    await type(KEYS.enter);
    await waitFor(() => frame().includes('Noted in'), 'saved notice');
    expect(await read('VINAX.md')).toContain('- always use tabs');
    await type('hi', KEYS.enter);
    await waitFor(() => frame().includes('Noted.'), 'answer');
    expect(lastRequest(harness)?.messages[0]?.content).toContain('- always use tabs');
  });

  it('switches models with /model and compacts with /compact', async () => {
    const { frame, type, harness } = await mount({
      groq: {
        script: {
          'main-model': [{ text: 'first' }],
          'other-model': [{ text: 'from other' }],
          'small-model': [{ text: 'Greeting session' }, { text: '## Goal\nSay hi.' }],
        },
      },
    });
    await type('hello', KEYS.enter);
    await waitFor(() => frame().includes('◆ first'), 'first');
    await type('/model groq:other-model', KEYS.enter);
    await waitFor(
      () => frame().includes('Using groq:other-model for this session'),
      'model notice',
    );
    await type('again', KEYS.enter);
    await waitFor(() => frame().includes('from other'), 'second');
    expect(lastRequest(harness)?.model).toBe('other-model');
    await type('/compact', KEYS.enter);
    await waitFor(() => frame().includes('Compacted the conversation'), 'compacted');
    const summaryReq = harness.groq.requests.filter(
      (r) => (r.body as { model?: string } | undefined)?.model === 'small-model',
    );
    expect(summaryReq.length).toBeGreaterThan(0);
  });

  it('shows /status, /usage and /doctor panels', async () => {
    const { frame, type } = await mount({ groq: { script: { 'main-model': [{ text: 'ok' }] } } });
    await type('hi', KEYS.enter);
    await waitFor(() => frame().includes('◆ ok'), 'answer');
    await type('/status', KEYS.enter);
    await waitFor(() => frame().includes('Status'), 'status');
    expect(frame()).toContain('model: groq:main-model');
    await type('/usage', KEYS.enter);
    await waitFor(() => /Groq — \d+ requests? ·/.test(frame()), 'usage');
    await type('/doctor', KEYS.enter);
    await waitFor(() => frame().includes('✔ Node.js'), 'doctor');
  });

  it('records the session for resuming and asks the app to clear', async () => {
    const { frame, type, onClear, writer, harness } = await mount({
      groq: { script: { 'main-model': [{ text: 'saved answer' }] } },
    });
    await type('remember me', KEYS.enter);
    await waitFor(() => frame().includes('saved answer'), 'answer');
    const { SessionStore, projectDataDir } = await import('@vinax/core');
    const loaded = new SessionStore(projectDataDir(harness.cwd, harness.env), harness.cwd).load(
      writer.id,
    );
    expect(loaded.messages.map((m) => m.content)).toEqual(['remember me', 'saved answer']);
    expect(loaded.views.map((v) => (v as { kind: string }).kind)).toEqual(['user', 'assistant']);
    await type('/clear', KEYS.enter);
    await waitFor(() => onClear.mock.calls.length === 1, 'clear');
  });

  it('supports vim bindings after /vim', async () => {
    const { frame, type } = await mount();
    await type('/vim', KEYS.enter);
    await waitFor(() => frame().includes('Vim mode on'), 'vim notice');
    expect(frame()).toContain('-- INSERT --');
    await type('hello world', KEYS.esc);
    expect(frame()).toContain('-- NORMAL --');
    await type('b', 'd', 'w');
    expect(frame()).toContain('› hello ');
    await type('u');
    expect(frame()).toContain('› hello world');
    await type('d', 'd');
    expect(frame()).toContain('Ask VinaX anything');
  });
});
