import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AppStateStore,
  effectiveContextWindow,
  encodeProjectPath,
  ModelCatalog,
  PromptHistory,
  RateLimitLedger,
  searchHistory,
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
    expect(await store.read()).toEqual({
      onboardingComplete: false,
      trustedDirs: [],
      approvedMcp: {},
    });
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

class CatalogProvider implements Provider {
  readonly name: ProviderName = 'groq';
  listModels = () =>
    Promise.resolve([{ id: 'm', contextWindow: 131_072, supportsTools: true, free: true }]);
  validateKey = () => Promise.resolve({ ok: true as const });
  // eslint-disable-next-line require-yield
  async *stream(): AsyncGenerator<StreamDelta> {
    await Promise.resolve();
  }
}

describe('effectiveContextWindow', () => {
  it('caps the context window by the tokens-per-minute budget', async () => {
    const ledger = new RateLimitLedger(() => 100);
    const deps = {
      providers: new Map([['groq' as const, new CatalogProvider()]]),
      catalog: new ModelCatalog(home),
      ledger,
    };
    expect(await effectiveContextWindow({ provider: 'groq', model: 'm' }, deps)).toBe(131_072);
    ledger.observe('groq', 'm', new Headers({ 'x-ratelimit-limit-tokens': '8000' }));
    expect(await effectiveContextWindow({ provider: 'groq', model: 'm' }, deps)).toBe(6000);
  });
});
