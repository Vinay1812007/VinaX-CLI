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
    // /key proves the key; the catalog is fetched afterwards to test its free models
    expect(h.openrouter.requests.filter((r) => r.path !== '/v1/models').at(-1)?.path).toBe(
      '/v1/key',
    );

    const keys = await h.run(['config', 'keys']);
    expect(keys.stdout).toContain('OpenRouter  sk-o…0000  (file)');
    expect(keys.stdout).toContain('Groq        not set');

    expect((await h.run(['config', 'remove-key', 'openrouter'])).stdout).toBe(
      'Removed the stored OpenRouter key.\n',
    );
  });

  it('tests the free models after a login and names one that answered', async () => {
    h = await createHarness({
      keys: false,
      settings: { model: 'nvidia:openai/gpt-oss-20b' },
      nvidia: {
        models: [
          { id: 'openai/gpt-oss-20b' },
          { id: 'meta/llama-3.1-8b-instruct' },
          { id: 'nvidia/nv-embedqa-e5-v5' },
        ],
        script: {
          // gone for the key check and the model test alike
          'openai/gpt-oss-20b': [
            { status: 404, error: { message: 'Function not found' } },
            { status: 404, error: { message: 'Function not found' } },
          ],
          'meta/llama-3.1-8b-instruct': [{ text: 'p' }, { text: 'OK' }],
        },
      },
    });
    const r = await h.run(['login', 'nvidia'], { stdin: 'nvapi-test0000000000\n' });
    expect(r.code).toBe(0);
    // another model answered the key check, so there is nothing to warn about
    expect(r.stderr).not.toContain('Could not verify');
    expect(r.stdout).toContain('Saved NVIDIA key to the credentials file');
    expect(r.stderr).toContain('Testing 2 free NVIDIA models…');
    expect(r.stdout).toContain('1 of 2 free NVIDIA models answered.');
    expect(r.stderr).toContain(
      'Your default model nvidia:openai/gpt-oss-20b did not answer. Use one that did: vinax config set model nvidia:meta/llama-3.1-8b-instruct',
    );
    const cached = JSON.parse(
      await fs.readFile(path.join(h.home, 'cache', 'probe-nvidia.json'), 'utf8'),
    ) as { results: { model: string; ok: boolean }[] };
    expect(cached.results.map((x) => [x.model, x.ok])).toEqual([
      ['openai/gpt-oss-20b', false],
      ['meta/llama-3.1-8b-instruct', true],
    ]);
  });

  it('rejects unknown providers', async () => {
    h = await createHarness();
    expect((await h.run(['config', 'set-key', 'anthropic'], { stdin: 'x' })).code).toBe(2);
  });
});
