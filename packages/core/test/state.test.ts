import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppStateStore, encodeProjectPath, PromptHistory, searchHistory } from '../src/index.js';

let home: string;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'vinax-state-'));
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('AppStateStore', () => {
  it('remembers onboarding and trusts folders and their children', async () => {
    const store = new AppStateStore({ VINAX_HOME: home });
    expect(await store.read()).toEqual({
      onboardingComplete: false,
      trustedDirs: [],
      approvedMcp: {},
      snakeBest: 0,
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
    const encoded = encodeProjectPath('/Users/me/my app');
    // on Windows the path gains the current drive letter, e.g. C--Users-me-my-app
    expect(encoded).toMatch(
      process.platform === 'win32' ? /^[A-Z]--Users-me-my-app$/i : /^-Users-me-my-app$/,
    );
  });
});
