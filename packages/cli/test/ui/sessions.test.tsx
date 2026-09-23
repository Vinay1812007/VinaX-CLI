import { PassThrough, Readable } from 'node:stream';
import { AppStateStore } from '@vinax/core';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppDeps } from '../../src/interactive.js';
import type { SessionOptions } from '../../src/session-options.js';
import { App, type StartChoice } from '../../src/ui/App.js';
import { createHarness, type Harness } from '../helpers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check: () => boolean, what: string): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 5000) throw new Error(`Timed out waiting for ${what}`);
    await sleep(20);
  }
}

let h: Harness | undefined;
let app: ReturnType<typeof render> | undefined;
afterEach(async () => {
  app?.unmount();
  app = undefined;
  await h?.cleanup();
  h = undefined;
});

const options: SessionOptions = {
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
};

async function mountApp(hh: Harness, start: StartChoice) {
  const env = { ...hh.env, PATH: process.env.PATH };
  await new AppStateStore(env).update((s) => ({
    ...s,
    onboardingComplete: true,
    trustedDirs: [hh.cwd],
  }));
  const io = {
    stdin: Object.assign(Readable.from([]), { isTTY: true }),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    env,
    cwd: hh.cwd,
  };
  const onExit = vi.fn();
  app = render(
    <App
      deps={createAppDeps(options, io)}
      version="1.0.0"
      cwd={hh.cwd}
      env={{ ...env, NO_COLOR: '1' }}
      tips={[]}
      start={start}
      onExit={onExit}
    />,
  );
  const frame = () => app?.lastFrame() ?? '';
  const type = async (...keys: string[]) => {
    await sleep(80);
    for (const k of keys) {
      app?.stdin.write(k);
      await sleep(30);
    }
  };
  return { frame, type };
}

describe('sessions in the app', () => {
  it('clears into a new session and resumes the old one with its transcript', async () => {
    h = await createHarness({
      groq: {
        script: {
          'main-model': [{ text: 'answer one' }, { text: 'answer two' }],
          'small-model': [{ text: 'First chat' }],
        },
      },
    });
    const { frame, type } = await mountApp(h, { kind: 'new' });
    await waitFor(() => frame().includes('Ask VinaX anything'), 'chat');
    await type('first prompt', '\r');
    await waitFor(() => frame().includes('answer one'), 'first answer');
    await type('/clear', '\x1b', '\r');
    await waitFor(
      () => !frame().includes('answer one') && frame().includes('Ask VinaX anything'),
      'cleared',
    );
    await type('/resume', '\x1b', '\r');
    await waitFor(() => frame().includes('Resume which conversation?'), 'resume picker');
    expect(frame()).toContain('First chat');
    await type('\r');
    await waitFor(() => frame().includes('Resumed “First chat”'), 'resumed');
    expect(frame()).toContain('› first prompt');
    expect(frame()).toContain('answer one');
    await type('second prompt', '\r');
    await waitFor(() => frame().includes('answer two'), 'second answer');
    const last = h.groq.requests.filter((r) => r.path === '/v1/chat/completions').at(-1)?.body as {
      messages: { content: string }[];
    };
    expect(last.messages.map((m) => m.content).slice(1)).toEqual([
      'first prompt',
      'answer one',
      'second prompt',
    ]);
  });

  it('continues the latest session with -c', async () => {
    h = await createHarness({ groq: { script: { 'main-model': [{ text: 'earlier answer' }] } } });
    const first = await mountApp(h, { kind: 'new' });
    await waitFor(() => first.frame().includes('Ask VinaX anything'), 'chat');
    await first.type('remember this', '\r');
    await waitFor(() => first.frame().includes('earlier answer'), 'answer');
    app?.unmount();
    const second = await mountApp(h, { kind: 'continue' });
    await waitFor(() => second.frame().includes('Resumed'), 'continued');
    expect(second.frame()).toContain('› remember this');
    expect(second.frame()).toContain('earlier answer');
  });
});
