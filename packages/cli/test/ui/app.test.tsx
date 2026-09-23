import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AppStateStore,
  type AgentSetup,
  type KeyCheck,
  type ModelInfo,
  type ProviderName,
  type Runtime,
} from '@vinax/core';
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App, type AppDeps } from '../../src/ui/App.js';
import { chatModels, type OnboardingDeps } from '../../src/ui/components/Onboarding.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check: () => boolean, what: string): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 3000) throw new Error(`Timed out waiting for ${what}`);
    await sleep(15);
  }
}

let home: string;
let app: ReturnType<typeof render> | undefined;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'vinax-app-'));
});
afterEach(async () => {
  app?.unmount();
  app = undefined;
  await fs.rm(home, { recursive: true, force: true });
});

const models: ModelInfo[] = [
  { id: 'openai/gpt-oss-120b', contextWindow: 131_072, supportsTools: undefined, free: false },
  { id: 'openai/gpt-oss-20b', contextWindow: 131_072, supportsTools: undefined, free: false },
  { id: 'whisper-large-v3', contextWindow: 448, supportsTools: undefined, free: false },
];

function fakeOnboarding(overrides: Partial<OnboardingDeps> = {}) {
  const saved: { keys: [ProviderName, string][]; settings: unknown[] } = { keys: [], settings: [] };
  const deps: OnboardingDeps = {
    envKey: () => undefined,
    storedKey: () => Promise.resolve(undefined),
    validateKey: (_p, key): Promise<KeyCheck> =>
      Promise.resolve(
        key === 'gsk_good'
          ? { ok: true }
          : { ok: false, rejected: true, reason: 'the key was rejected' },
      ),
    saveKey: (p, key) => {
      saved.keys.push([p, key]);
      return Promise.resolve();
    },
    listModels: () => Promise.resolve(models),
    saveSettings: (patch) => {
      saved.settings.push(patch);
      return Promise.resolve();
    },
    defaultModel: 'groq:openai/gpt-oss-120b',
    ...overrides,
  };
  return { deps, saved };
}

function mountApp(onboarding: OnboardingDeps) {
  const state = new AppStateStore({ VINAX_HOME: home });
  const createSession = vi.fn((): Promise<{ runtime: Runtime; setup: AgentSetup }> =>
    Promise.reject(new Error('chat is not under test here')),
  );
  const deps: AppDeps = {
    state,
    loadTheme: () => Promise.resolve('dark'),
    createSession,
    onboarding,
  };
  const onExit = vi.fn();
  app = render(
    <App
      deps={deps}
      version="1.0.0"
      cwd={path.join(home, 'proj')}
      env={{ NO_COLOR: '1' }}
      tips={[]}
      onExit={onExit}
    />,
  );
  const frame = () => app?.lastFrame() ?? '';
  const type = async (...chunks: string[]) => {
    await sleep(100);
    for (const c of chunks) {
      app?.stdin.write(c);
      await sleep(25);
    }
  };
  return { state, frame, type, onExit, createSession };
}

describe('onboarding', () => {
  it('walks theme → provider → key (validated live) → model, then asks for folder trust', async () => {
    const { deps, saved } = fakeOnboarding();
    const { frame, type, state } = mountApp(deps);
    await waitFor(() => frame().includes('Choose a colour theme'), 'theme step');
    expect(frame()).toContain('setup 1/4');
    await type('\x1b[B', '\r'); // Light
    await waitFor(() => frame().includes('Which provider'), 'provider step');
    await type('1'); // Groq
    await waitFor(() => frame().includes('Groq API key'), 'key step');
    await type('gsk_bad', '\r');
    await waitFor(() => frame().includes('Groq rejected that key'), 'rejection');
    expect(frame()).not.toContain('gsk_bad');
    await type('gsk_good', '\r');
    await waitFor(() => frame().includes('Key saved — Groq accepted it.'), 'accepted');
    await type('\r');
    await waitFor(() => frame().includes('Pick your default model'), 'model step');
    expect(frame()).not.toContain('whisper');
    await type('\x1b[B', '\r'); // gpt-oss-20b
    await waitFor(() => frame().includes("You're all set"), 'done step');
    await type('\r');
    await waitFor(() => frame().includes('Do you trust the files in this folder?'), 'trust prompt');
    expect(saved.keys).toEqual([['groq', 'gsk_good']]);
    expect(saved.settings).toEqual([{ theme: 'light', model: 'groq:openai/gpt-oss-20b' }]);
    expect((await state.read()).onboardingComplete).toBe(true);
  });

  it('reuses a key from the environment after checking it', async () => {
    const { deps, saved } = fakeOnboarding({
      envKey: (p) => (p === 'groq' ? 'gsk_good' : undefined),
    });
    const { frame, type } = mountApp(deps);
    await waitFor(() => frame().includes('Choose a colour theme'), 'theme step');
    await type('\r', '1');
    await waitFor(
      () => frame().includes('Using GROQ_API_KEY — Groq accepted it.'),
      'env key accepted',
    );
    expect(saved.keys).toEqual([]);
  });

  it('filters the model list to chat models (free-only on OpenRouter)', () => {
    const list: ModelInfo[] = [
      { id: 'a:free', contextWindow: 262_144, supportsTools: true, free: true },
      { id: 'paid', contextWindow: 262_144, supportsTools: true, free: false },
      { id: 'no-tools:free', contextWindow: 262_144, supportsTools: false, free: true },
    ];
    expect(chatModels(list, 'openrouter').map((m) => m.id)).toEqual(['a:free']);
    expect(chatModels(models, 'groq').map((m) => m.id)).toEqual([
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b',
    ]);
  });
});

describe('folder trust', () => {
  it('exits with code 1 when the folder is not trusted', async () => {
    const { deps } = fakeOnboarding();
    await new AppStateStore({ VINAX_HOME: home }).update((s) => ({
      ...s,
      onboardingComplete: true,
    }));
    const { frame, type, onExit, createSession } = mountApp(deps);
    await waitFor(() => frame().includes('Do you trust'), 'trust prompt');
    await type('\x1b[B', '\r');
    expect(onExit).toHaveBeenCalledWith(1);
    expect(createSession).not.toHaveBeenCalled();
  });

  it('remembers trust and starts the chat', async () => {
    const { deps } = fakeOnboarding();
    const state = new AppStateStore({ VINAX_HOME: home });
    await state.update((s) => ({ ...s, onboardingComplete: true }));
    const { frame, type, createSession } = mountApp(deps);
    await waitFor(() => frame().includes('Do you trust'), 'trust prompt');
    await type('\r');
    await waitFor(() => createSession.mock.calls.length === 1, 'runtime start');
    expect(await state.isTrusted(path.join(home, 'proj', 'sub'))).toBe(true);
  });
});
