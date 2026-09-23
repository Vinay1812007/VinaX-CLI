import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AbortError,
  AppStateStore,
  ChatSession,
  DEFAULT_SETTINGS,
  effectiveContextWindow,
  encodeProjectPath,
  INTERRUPTED_MARKER,
  ModelCatalog,
  ProviderError,
  PromptHistory,
  RateLimitLedger,
  Router,
  searchHistory,
  type ChatRequest,
  type Provider,
  type ProviderName,
  type StreamDelta,
} from '../src/index.js';

let home: string;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'vinax-state-'));
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe('AppStateStore', () => {
  it('remembers onboarding and trusts folders and their children', async () => {
    const store = new AppStateStore({ VINAX_HOME: home });
    expect(await store.read()).toEqual({ onboardingComplete: false, trustedDirs: [] });
    await store.update((s) => ({ ...s, onboardingComplete: true }));
    const project = path.join(home, 'work', 'app');
    expect(await store.isTrusted(project)).toBe(false);
    await store.trust(path.join(home, 'work'));
    expect(await store.isTrusted(project)).toBe(true);
    expect(await store.isTrusted(path.join(home, 'workshop'))).toBe(false);
    expect((await new AppStateStore({ VINAX_HOME: home }).read()).onboardingComplete).toBe(true);
  });

  it('recovers from a corrupt state file', async () => {
    const store = new AppStateStore({ VINAX_HOME: home });
    await fs.writeFile(store.file, '{oops', 'utf8');
    expect((await store.read()).trustedDirs).toEqual([]);
  });
});

describe('PromptHistory', () => {
  it('returns newest first, skips repeats and survives reloads', async () => {
    const file = path.join(home, 'h.jsonl');
    const h = new PromptHistory(file);
    await h.add('first');
    await h.add('multi\nline');
    await h.add('multi\nline');
    await h.add('   ');
    expect(await h.load()).toEqual(['multi\nline', 'first']);
    expect(await new PromptHistory(file).load()).toEqual(['multi\nline', 'first']);
    expect(searchHistory(['Fix tests', 'add docs', 'fix lint'], 'fix')).toEqual([
      'Fix tests',
      'fix lint',
    ]);
  });

  it('encodes project paths into safe folder names', () => {
    expect(encodeProjectPath('/Users/me/my app')).toBe('-Users-me-my-app');
  });
});

class ScriptedProvider implements Provider {
  readonly name: ProviderName = 'groq';
  seen: ChatRequest[] = [];
  constructor(private readonly steps: (string[] | Error)[]) {}
  listModels = () =>
    Promise.resolve([{ id: 'm', contextWindow: 131_072, supportsTools: true, free: true }]);
  validateKey = () => Promise.resolve({ ok: true as const });
  async *stream(req: ChatRequest): AsyncGenerator<StreamDelta> {
    this.seen.push({ ...req, messages: [...req.messages] });
    const step = this.steps.shift();
    if (step instanceof Error) throw step;
    for (const t of step ?? []) {
      await Promise.resolve();
      if (req.signal.aborted) throw new ProviderError('aborted', 'aborted', 'groq');
      yield { type: 'text', text: t };
    }
  }
}

function sessionWith(provider: ScriptedProvider) {
  const settings = {
    ...DEFAULT_SETTINGS,
    model: 'groq:m',
    fallbackChain: [],
    router: { ...DEFAULT_SETTINGS.router, maxRetries: 0 },
  };
  const ledger = new RateLimitLedger(() => 100);
  const router = new Router({ providers: new Map([['groq', provider]]), ledger, settings });
  return { session: new ChatSession(router, 'SYSTEM'), ledger };
}

describe('ChatSession', () => {
  it('keeps multi-turn history', async () => {
    const p = new ScriptedProvider([['Hi', ' there'], ['Second']]);
    const { session } = sessionWith(p);
    const events: string[] = [];
    const a = await session.send('hello', {
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e.type),
    });
    expect(a).toMatchObject({ status: 'done', text: 'Hi there' });
    await session.send('again', { signal: new AbortController().signal, onEvent: () => undefined });
    expect(p.seen[1]?.messages.map((m) => `${m.role}:${m.content}`)).toEqual([
      'system:SYSTEM',
      'user:hello',
      'assistant:Hi there',
      'user:again',
    ]);
    expect(events).toEqual(['attempt', 'text', 'text', 'done']);
  });

  it('records partial answers on interrupt', async () => {
    const p = new ScriptedProvider([['part', 'never']]);
    const { session } = sessionWith(p);
    const ac = new AbortController();
    const outcome = await session.send('q', {
      signal: ac.signal,
      onEvent: (e) => {
        if (e.type === 'text') ac.abort();
      },
    });
    expect(outcome).toMatchObject({ status: 'interrupted', text: 'part' });
    expect(session.messages.at(-1)).toEqual({
      role: 'assistant',
      content: `part\n\n${INTERRUPTED_MARKER}`,
    });
  });

  it('drops the unanswered prompt when the request fails', async () => {
    const p = new ScriptedProvider([new ProviderError('auth', 'Groq 401: bad key', 'groq', 401)]);
    const { session } = sessionWith(p);
    const outcome = await session.send('q', {
      signal: new AbortController().signal,
      onEvent: () => undefined,
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toContain('Groq 401: bad key');
    expect(session.messages).toHaveLength(1);
    expect(AbortError).toBeDefined();
  });

  it('caps the context window by the tokens-per-minute budget', async () => {
    const p = new ScriptedProvider([]);
    const { ledger } = sessionWith(p);
    const deps = {
      providers: new Map([['groq' as const, p]]),
      catalog: new ModelCatalog(home),
      ledger,
    };
    expect(await effectiveContextWindow({ provider: 'groq', model: 'm' }, deps)).toBe(131_072);
    ledger.observe('groq', 'm', new Headers({ 'x-ratelimit-limit-tokens': '8000' }));
    expect(await effectiveContextWindow({ provider: 'groq', model: 'm' }, deps)).toBe(6000);
  });
});
