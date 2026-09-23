import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { composePrompt } from '../src/print.js';
import { createHarness, type Harness } from './helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

describe('composePrompt', () => {
  it('combines a prompt with piped input', () => {
    expect(composePrompt('explain', 'const x = 1;\n')).toBe(
      'explain\n\n<stdin>\nconst x = 1;\n</stdin>',
    );
    expect(composePrompt(undefined, ' only stdin ')).toBe('only stdin');
    expect(composePrompt('only prompt', '')).toBe('only prompt');
  });
});

describe('vinax -p', () => {
  it('streams the answer to stdout and exits 0', async () => {
    h = await createHarness({
      groq: { script: { 'main-model': [{ text: ['Hello ', 'from ', 'VinaX'] }] } },
    });
    const r = await h.run(['-p', 'say hi'], { stdin: 'piped context' });
    expect(r).toMatchObject({ code: 0, stdout: 'Hello from VinaX\n' });
    const body = h.groq.requests.at(-1)?.body as { messages: { role: string; content: string }[] };
    expect(body.messages[0]?.content).toContain(`Project root: ${h.cwd}`);
    expect(body.messages[1]?.content).toBe('say hi\n\n<stdin>\npiped context\n</stdin>');
  });

  it('falls back to OpenRouter when Groq is rate-limited, with a one-line notice', async () => {
    h = await createHarness({
      groq: {
        script: {
          'main-model': [
            {
              status: 429,
              headers: { 'retry-after': '120' },
              error: { message: 'Rate limit reached for tokens per minute' },
            },
          ],
        },
      },
      openrouter: { script: { 'free-model:free': [{ text: 'fallback answer' }] } },
    });
    const r = await h.run(['-p', 'hi', '--output-format', 'json']);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe(
      '↪ Groq 429: Rate limit reached for tokens per minute — switched to openrouter:free-model:free\n',
    );
    const result = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(result).toMatchObject({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'fallback answer',
      model: 'openrouter:free-model:free',
      fallbacks: [{ from: 'groq:main-model', to: 'openrouter:free-model:free' }],
    });
    expect(h.openrouter.requests.at(-1)?.headers['x-title']).toBe('VinaX CLI');
  });

  it('retries a transient 503 on the same model before succeeding', async () => {
    h = await createHarness({
      groq: { script: { 'main-model': [{ status: 503 }, { text: 'ok' }] } },
    });
    const r = await h.run(['-p', 'hi']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('ok\n');
    expect(r.stderr).toMatch(/^↻ Groq 503: mock error 503 — retrying in 0\.0s\n$/);
  });

  it('emits NDJSON events with --output-format stream-json', async () => {
    h = await createHarness({
      groq: {
        script: {
          'main-model': [{ text: ['a', 'b'], usage: { prompt_tokens: 9, completion_tokens: 2 } }],
        },
      },
    });
    const r = await h.run(['-p', 'hi', '--output-format', 'stream-json']);
    const events = r.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events.map((e) => e.type)).toEqual(['system', 'text', 'text', 'result']);
    expect(events[0]).toMatchObject({
      subtype: 'init',
      models: ['groq:main-model', 'openrouter:free-model:free'],
    });
    expect(events[3]).toMatchObject({ result: 'ab', usage: { input_tokens: 9, output_tokens: 2 } });
  });

  it('exits 1 and lists every failure when the whole chain fails', async () => {
    h = await createHarness({
      groq: { script: { 'main-model': [{ status: 404, error: { message: 'model not found' } }] } },
      openrouter: {
        script: {
          'free-model:free': [{ status: 401, error: { message: 'No auth credentials found' } }],
        },
      },
    });
    const r = await h.run(['-p', 'hi', '--output-format', 'json']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('✖ Every model in the fallback chain failed:');
    expect(r.stderr).toContain('groq:main-model: Groq 404: model not found');
    expect(r.stderr).toContain(
      'openrouter:free-model:free: OpenRouter 401: No auth credentials found',
    );
    expect(JSON.parse(r.stdout)).toMatchObject({ subtype: 'error', is_error: true });
  });

  it('skips configured models missing from the provider catalog', async () => {
    h = await createHarness({
      groq: { models: [{ id: 'small-model' }] },
      openrouter: {
        models: [{ id: 'free-model:free' }],
        script: { 'free-model:free': [{ text: 'ok' }] },
      },
    });
    const r = await h.run(['-p', 'hi']);
    expect(r.code).toBe(0);
    expect(
      r.stderr.match(/groq:main-model is not in Groq's model list; skipping it\./g),
    ).toHaveLength(1);
    expect(h.groq.requests.filter((q) => q.path === '/v1/chat/completions')).toHaveLength(0);
  });

  it('explains how to add a key when none is configured', async () => {
    h = await createHarness({ keys: false });
    const r = await h.run(['-p', 'hi']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('No API key found for any provider.');
    expect(r.stderr).toContain('vinax config set-key groq');
  });

  it('exits 2 on usage errors', async () => {
    h = await createHarness();
    expect((await h.run(['-p'])).code).toBe(2);
    const bad = await h.run(['-p', 'hi', '--model', 'gpt-4']);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('expected "<provider>:<model-id>"');
    expect((await h.run(['-p', 'hi', '--output-format', 'xml'])).code).toBe(2);
  });

  it('exits 130 when interrupted', async () => {
    h = await createHarness({
      groq: { script: { 'main-model': [{ text: 'never', delayMs: 5000 }] } },
    });
    const ac = new AbortController();
    setTimeout(() => {
      ac.abort();
    }, 150);
    const r = await h.run(['-p', 'hi'], { signal: ac.signal });
    expect(r.code).toBe(130);
    expect(r.stderr).toContain('✖ Interrupted');
  });

  it('refuses interactive mode without a terminal and points to -p', async () => {
    h = await createHarness();
    const r = await h.run(['hello']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Interactive mode needs a terminal');
  });

  it('uses --model ahead of the configured chain', async () => {
    h = await createHarness({ openrouter: { script: { 'other:free': [{ text: 'picked' }] } } });
    const r = await h.run(['-p', 'hi', '--model', 'openrouter:other:free']);
    expect(r.stdout).toBe('picked\n');
  });

  it('writes a redacted debug log with --verbose', async () => {
    h = await createHarness({ groq: { script: { 'main-model': [{ text: 'ok' }] } } });
    const r = await h.run(['-p', 'hi', '--verbose']);
    const logFile = /debug log: (.+)\n/.exec(r.stderr)?.[1];
    expect(logFile).toBeDefined();
    const { readFile } = await import('node:fs/promises');
    const log = await readFile(logFile ?? '', 'utf8');
    expect(log).toContain('"event":"request"');
    expect(log).not.toContain('gsk_mockkey');
  });
});

describe('vinax binary', () => {
  it('runs from a real process with piped stdin', async () => {
    h = await createHarness({ groq: { script: { 'main-model': [{ text: 'piped ok' }] } } });
    const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'bin.ts');
    const env = { ...process.env, ...h.env };
    const result = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      const child = execFile(
        process.execPath,
        ['--import', import.meta.resolve('tsx'), bin, '-p'],
        { cwd: h?.cwd, env },
        (_err, stdout) => {
          resolve({ code: child.exitCode, stdout });
        },
      );
      child.stdin?.end('hello from a pipe');
    });
    expect(result).toEqual({ code: 0, stdout: 'piped ok\n' });
    const body = h.groq.requests.at(-1)?.body as { messages: { content: string }[] };
    expect(body.messages[1]?.content).toBe('hello from a pipe');
  });
});

describe('vinax -p with tools', () => {
  const tc = (name: string, args: Record<string, unknown>) => ({
    name,
    arguments: JSON.stringify(args),
  });

  it('streams tool_use and tool_result events', async () => {
    h = await createHarness({
      groq: { script: { 'main-model': [{ toolCalls: [tc('LS', {})] }, { text: 'Listed.' }] } },
    });
    const r = await h.run(['-p', 'list files', '--output-format', 'stream-json']);
    const events = r.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events.map((e) => e.type)).toEqual([
      'system',
      'tool_use',
      'tool_result',
      'text',
      'result',
    ]);
    expect(events[2]).toMatchObject({ name: 'LS', is_error: false });
    expect(events.at(-1)).toMatchObject({ result: 'Listed.', num_turns: 2, tool_calls: 1 });
  });

  it('refuses actions that need approval and tells the model how to allow them', async () => {
    h = await createHarness({
      groq: {
        script: {
          'main-model': [
            { toolCalls: [tc('Bash', { command: 'npm test' })] },
            { text: 'Could not run the tests.' },
          ],
        },
      },
    });
    const r = await h.run(['-p', 'run tests']);
    expect(r.code).toBe(0);
    const toolMsg = (
      h.groq.requests.at(-1)?.body as { messages: { role: string; content: string }[] }
    ).messages.at(-1);
    expect(toolMsg?.content).toContain('Print mode cannot ask for approval');
    expect(toolMsg?.content).toContain('--allowedTools "Bash(npm test:*)"');
  });

  it('runs commands allowed with --allowedTools and edits with --permission-mode acceptEdits', async () => {
    h = await createHarness({
      groq: {
        script: {
          'main-model': [
            {
              toolCalls: [
                tc('Bash', { command: 'echo from-bash' }),
                tc('Write', { file_path: 'out.txt', content: 'hi\n' }),
              ],
            },
            { text: 'Done.' },
          ],
        },
      },
    });
    const r = await h.run([
      '-p',
      'go',
      '--allowedTools',
      'Bash(echo:*),Read',
      '--permission-mode',
      'acceptEdits',
      '--output-format',
      'json',
    ]);
    expect(r.code).toBe(0);
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(path.join(h.cwd, 'out.txt'), 'utf8')).toBe('hi\n');
    const tools = (
      h.groq.requests.at(-1)?.body as { messages: { role: string; content: string }[] }
    ).messages.filter((m) => m.role === 'tool');
    expect(tools.map((m) => m.content)).toEqual(['from-bash', 'Created out.txt (1 lines).']);
  });

  it('stops at --max-turns with exit code 1', async () => {
    const ls = { toolCalls: [tc('LS', {})] };
    h = await createHarness({ groq: { script: { 'main-model': [ls, ls, ls] } } });
    const r = await h.run(['-p', 'loop', '--max-turns', '2']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Stopped after 2 model calls (--max-turns).');
    expect((await h.run(['-p', 'x', '--max-turns', '0'])).code).toBe(2);
  });
});

describe('vinax -p sessions and doctor', () => {
  it('continues the latest session with -c and reports the session id', async () => {
    h = await createHarness({
      groq: { script: { 'main-model': [{ text: 'one' }, { text: 'two' }] } },
    });
    const first = await h.run(['-p', 'first question', '--output-format', 'json']);
    const id = (JSON.parse(first.stdout) as { session_id: string }).session_id;
    expect(id).toMatch(/^\d{8}-\d{6}-[0-9a-f]{6}$/);
    const second = await h.run(['-p', 'follow up', '-c', '--output-format', 'json']);
    expect((JSON.parse(second.stdout) as { session_id: string }).session_id).toBe(id);
    const body = h.groq.requests.at(-1)?.body as { messages: { content: string }[] };
    expect(body.messages.slice(1).map((m) => m.content)).toEqual([
      'first question',
      'one',
      'follow up',
    ]);
    expect((await h.run(['-p', 'x', '-r'])).code).toBe(2);
  });

  it('runs vinax doctor', async () => {
    h = await createHarness({ keys: false });
    const r = await h.run(['doctor']);
    expect(r.stdout).toContain('✔ Node.js');
    expect(r.stdout).toContain('✖ API keys');
    expect(r.code).toBe(1);
  });
});
