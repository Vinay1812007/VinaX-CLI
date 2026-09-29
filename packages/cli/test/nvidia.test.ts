import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const chatModel = (server: Harness['nvidia']) =>
  (
    server.requests.find((r) => r.path === '/v1/chat/completions')?.body as
      { model?: string } | undefined
  )?.model;

describe('NVIDIA from the command line', () => {
  it('answers with --model NVD_CHAT_OSS_20_B through the NVIDIA provider', async () => {
    h = await createHarness({
      nvidiaKey: true,
      nvidia: { script: { 'openai/gpt-oss-20b': [{ text: 'hello from nvidia' }] } },
    });
    const r = await h.run(['-p', 'hi', '--model', 'NVD_CHAT_OSS_20_B']);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('hello from nvidia');
    expect(chatModel(h.nvidia)).toBe('openai/gpt-oss-20b');
    const auth = h.nvidia.requests.find((q) => q.path === '/v1/chat/completions')?.headers
      .authorization;
    expect(auth).toBe('Bearer nvapi-mockkey000000');
  });

  it('accepts nvidia:… and nvidia.com:… model refs', async () => {
    h = await createHarness({
      nvidiaKey: true,
      nvidia: {
        script: { 'openai/gpt-oss-20b': [{ text: 'one' }, { text: 'two' }] },
      },
    });
    expect((await h.run(['-p', 'a', '--model', 'nvidia:openai/gpt-oss-20b'])).stdout).toContain(
      'one',
    );
    expect((await h.run(['-p', 'b', '--model', 'nvidia.com:openai/gpt-oss-20b'])).stdout).toContain(
      'two',
    );
  });

  it('falls back from NVIDIA to Groq when NVIDIA is rate limited', async () => {
    h = await createHarness({
      nvidiaKey: true,
      settings: { model: 'nvidia:openai/gpt-oss-20b', fallbackChain: ['groq:main-model'] },
      nvidia: {
        script: {
          'openai/gpt-oss-20b': [
            { status: 429, error: { message: 'Too many requests' } },
            { status: 429, error: { message: 'Too many requests' } },
          ],
        },
      },
      groq: { script: { 'main-model': [{ text: 'groq saved the day' }] } },
    });
    const r = await h.run(['-p', 'hi', '--output-format', 'json']);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as { result: string; fallbacks: unknown[] };
    expect(out.result).toBe('groq saved the day');
    expect(out.fallbacks).toMatchObject([
      { from: 'nvidia:openai/gpt-oss-20b', to: 'groq:main-model' },
    ]);
  });

  it('explains a missing NVIDIA key and a rejected one', async () => {
    h = await createHarness({
      settings: { model: 'nvidia:openai/gpt-oss-20b', fallbackChain: [] },
    });
    const missing = await h.run(['-p', 'hi']);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('• NVIDIA · openai/gpt-oss-20b — no API key');
    expect(missing.stderr).toContain('NVIDIA_API_KEY');
    await h.cleanup();

    h = await createHarness({
      nvidiaKey: true,
      settings: { model: 'NVD_CHAT_OSS_20_B', fallbackChain: [] },
      nvidia: { apiKeys: ['nvapi-someone-else'] },
    });
    const rejected = await h.run(['-p', 'hi']);
    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain('authentication failed: HTTP 401: Invalid API Key');
    expect(rejected.stderr).toContain('run /health');
  });

  it('rejects unknown models with a helpful message', async () => {
    h = await createHarness();
    const r = await h.run(['-p', 'hi', '--model', 'NVD_NOT_A_MODEL']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('providers: groq, openrouter, nvidia');
    expect(r.stderr).toContain('NVD_CHAT_OSS_20_B');
  });
});

describe('vinax health', () => {
  it('prints a grouped summary and exits 0 when nothing fails', async () => {
    h = await createHarness({
      groq: { models: [{ id: 'main-model', context_window: 131072 }, { id: 'small-model' }] },
    });
    const r = await h.run(['health']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^VinaX health {2}\d+ ok · \d+ warnings? · 0 failures/);
    for (const heading of ['Runtime', 'Providers & models', 'Tools', 'Integrations'])
      expect(r.stdout).toContain(`\n${heading}\n`);
    expect(r.stdout).toContain('✔ Groq key');
    expect(r.stdout).toContain('○ NVIDIA key');
    expect(r.stdout).toContain('not set (optional: set NVIDIA_API_KEY');
    expect(r.stdout).toContain('MCP');
    expect(r.stdout).toContain('Gateway');
  });

  it('exits 1 when no provider can answer', async () => {
    h = await createHarness({ keys: false });
    const r = await h.run(['health']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('✖ API keys');
  });

  it('keeps doctor working with the new optional status', async () => {
    h = await createHarness();
    const r = await h.run(['doctor']);
    expect(r.stdout).toContain('✔ VinaX');
    expect(r.stdout).toContain('○ NVIDIA key');
  });
});
