import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

describe('vinax config', () => {
  it('sets, gets and unsets values per scope', async () => {
    h = await createHarness();
    expect(
      (await h.run(['config', 'set', 'router.maxRetries', '4', '--scope', 'project'])).code,
    ).toBe(0);
    expect((await h.run(['config', 'get', 'router.maxRetries'])).stdout).toBe('4\n');
    const project = JSON.parse(
      await fs.readFile(path.join(h.cwd, '.vinax', 'settings.json'), 'utf8'),
    ) as unknown;
    expect(project).toEqual({ router: { maxRetries: 4 } });

    await h.run(['config', 'unset', 'router.maxRetries', '--scope', 'project']);
    expect((await h.run(['config', 'get', 'router.maxRetries'])).stdout).toBe('1\n'); // from user settings
  });

  it('rejects invalid values with a helpful message', async () => {
    h = await createHarness();
    const r = await h.run(['config', 'set', 'model', 'llama']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('model: expected "<provider>:<model-id>"');
  });

  it('lists effective settings and file locations', async () => {
    h = await createHarness();
    const r = await h.run(['config', 'list']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('"model": "groq:main-model"');
    expect(r.stdout).toContain(path.join(h.cwd, '.vinax', 'settings.local.json'));
  });

  it('verifies, stores and reports keys', async () => {
    h = await createHarness({ keys: false, openrouter: { apiKeys: ['sk-or-v1-good0000000000'] } });
    const bad = await h.run(['config', 'set-key', 'openrouter'], {
      stdin: 'sk-or-v1-bad00000000000\n',
    });
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('OpenRouter rejected that key; it was not saved.');

    const good = await h.run(['config', 'set-key', 'openrouter'], {
      stdin: 'sk-or-v1-good0000000000\n',
    });
    expect(good.code).toBe(0);
    expect(good.stdout).toContain('Saved OpenRouter key to the credentials file');
    expect(h.openrouter.requests.at(-1)?.path).toBe('/v1/key');

    const keys = await h.run(['config', 'keys']);
    expect(keys.stdout).toContain('OpenRouter  sk-o…0000  (file)');
    expect(keys.stdout).toContain('Groq        not set');

    expect((await h.run(['config', 'remove-key', 'openrouter'])).stdout).toBe(
      'Removed the stored OpenRouter key.\n',
    );
  });

  it('rejects unknown providers', async () => {
    h = await createHarness();
    expect((await h.run(['config', 'set-key', 'anthropic'], { stdin: 'x' })).code).toBe(2);
  });
});
