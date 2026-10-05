import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  startMockServer,
  type MockServer,
  type MockServerOptions,
  systemEnv,
} from '@vinax/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  costOf,
  createAgentSetup,
  createRuntime,
  formatCost,
  priceFor,
  type AgentEvent,
  type AgentHost,
  type AgentSetup,
  type PermissionAnswer,
  type PermissionMode,
  type PermissionRequest,
} from '../src/index.js';

interface Ctx {
  root: string;
  cwd: string;
  groq: MockServer;
  openrouter: MockServer;
  setup: AgentSetup;
  events: AgentEvent[];
  asks: PermissionRequest[];
  host: AgentHost & { modeValue: PermissionMode };
}

let ctx: Ctx | undefined;
afterEach(async () => {
  if (!ctx) return;
  ctx.setup.shell.killAll();
  await ctx.groq.close();
  await ctx.openrouter.close();
  await fs.rm(ctx.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  ctx = undefined;
});

async function start(opts: {
  groq?: MockServerOptions;
  openrouter?: MockServerOptions;
  answers?: PermissionAnswer[];
  model?: string;
  maxTurns?: number;
  files?: Record<string, string>;
  settings?: Record<string, unknown>;
}): Promise<Ctx> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vinax-agent-')));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'project');
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(cwd, { recursive: true });
  for (const [rel, text] of Object.entries(opts.files ?? {})) {
    await fs.mkdir(path.dirname(path.join(cwd, rel)), { recursive: true });
    await fs.writeFile(path.join(cwd, rel), text);
  }
  const groq = await startMockServer(opts.groq);
  const openrouter = await startMockServer(opts.openrouter);
  await fs.writeFile(
    path.join(home, 'settings.json'),
    JSON.stringify({
      model: 'groq:main',
      fallbackChain: ['openrouter:free:free'],
      providers: { groq: { baseUrl: groq.url }, openrouter: { baseUrl: openrouter.url } },
      router: {
        maxRetries: 0,
        baseDelayMs: 5,
        maxDelayMs: 10,
        maxWaitMs: 100,
        requestTimeoutMs: 5000,
      },
      ...opts.settings,
    }),
  );
  const env = {
    VINAX_HOME: home,
    VINAX_SECRETS_BACKEND: 'file',
    GROQ_API_KEY: 'gsk_test00000000',
    OPENROUTER_API_KEY: 'sk-or-v1-test0000',
    ...systemEnv(),
  };
  const runtime = await createRuntime({ cwd, env });
  const setup = await createAgentSetup(runtime, {
    ...(opts.model === undefined ? {} : { model: opts.model }),
    ...(opts.maxTurns === undefined ? {} : { maxTurns: opts.maxTurns }),
  });
  const answers = [...(opts.answers ?? [])];
  const asks: PermissionRequest[] = [];
  const host = {
    modeValue: 'default' as PermissionMode,
    mode() {
      return this.modeValue;
    },
    askPermission(req: PermissionRequest) {
      asks.push(req);
      return Promise.resolve(answers.shift() ?? { kind: 'deny' as const, feedback: '' });
    },
    approvePlan(): Promise<{ approved: true; mode: 'acceptEdits' }> {
      host.modeValue = 'acceptEdits';
      return Promise.resolve({ approved: true, mode: 'acceptEdits' });
    },
  };
  ctx = { root, cwd, groq, openrouter, setup, events: [], asks, host };
  return ctx;
}

function run(c: Ctx, prompt: string, signal = new AbortController().signal) {
  return c.setup.agent.run(prompt, { signal, host: c.host, onEvent: (e) => c.events.push(e) });
}

type Body = {
  messages: {
    role: string;
    content: string | null;
    tool_calls?: unknown[];
    tool_call_id?: string;
  }[];
  tools?: { function: { name: string } }[];
};
const bodies = (s: MockServer): Body[] =>
  s.requests.filter((r) => r.path === '/v1/chat/completions').map((r) => r.body as Body);

describe('Agent (native tool calling)', () => {
  it('runs read-only tools in parallel without asking and feeds results back', async () => {
    const c = await start({
      files: { 'src/a.ts': 'export const a = 1; // TODO\n' },
      groq: {
        script: {
          main: [
            {
              text: 'Looking around.',
              toolCalls: [
                { id: 'c1', name: 'Read', arguments: '{"file_path":"src/a.ts"}' },
                { id: 'c2', name: 'Grep', arguments: '{"pattern":"TODO"}' },
              ],
            },
            { text: 'Found one TODO in src/a.ts.' },
          ],
        },
      },
    });
    const out = await run(c, 'find todos');
    expect(out).toMatchObject({ status: 'done', text: 'Found one TODO in src/a.ts.', steps: 2 });
    expect(c.asks).toEqual([]);
    const results = c.events.flatMap((e) =>
      e.type === 'tool_result' ? [[e.name, e.ok, e.summary]] : [],
    );
    // parallel calls finish in either order
    expect(results).toHaveLength(2);
    expect(results).toEqual(
      expect.arrayContaining([
        ['Read', true, 'Read 1 line'],
        ['Grep', true, 'Found 1 file'],
      ]),
    );
    const [first, second] = bodies(c.groq);
    expect(first?.tools?.map((t) => t.function.name)).toContain('Edit');
    expect(first?.tools?.map((t) => t.function.name)).not.toContain('ExitPlanMode');
    expect(second?.messages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'tool',
    ]);
    expect(second?.messages[2]).toMatchObject({
      content: 'Looking around.',
      tool_calls: [{ id: 'c1' }, { id: 'c2' }],
    });
    expect(second?.messages[3]).toMatchObject({
      tool_call_id: 'c1',
      content: '     1\texport const a = 1; // TODO',
    });
  });

  it('asks before editing, applies the edit, and can restore the checkpoint', async () => {
    const c = await start({
      files: { 'a.txt': 'hello world\n' },
      answers: [{ kind: 'allow' }],
      groq: {
        script: {
          main: [
            { toolCalls: [{ name: 'Read', arguments: '{"file_path":"a.txt"}' }] },
            {
              toolCalls: [
                {
                  name: 'Edit',
                  arguments: '{"file_path":"a.txt","old_string":"world","new_string":"VinaX"}',
                },
              ],
            },
            { text: 'Changed it.' },
          ],
        },
      },
    });
    expect((await run(c, 'change it')).status).toBe('done');
    expect(c.asks).toHaveLength(1);
    expect(c.asks[0]).toMatchObject({
      tool: 'Edit',
      label: 'a.txt',
      preview: { kind: 'diff', added: 1, removed: 1 },
    });
    expect(await fs.readFile(path.join(c.cwd, 'a.txt'), 'utf8')).toBe('hello VinaX\n');
    expect(c.setup.checkpoints.changedSince(1)).toEqual([path.join(c.cwd, 'a.txt')]);
    await c.setup.checkpoints.restoreTo(1);
    expect(await fs.readFile(path.join(c.cwd, 'a.txt'), 'utf8')).toBe('hello world\n');
    expect(c.setup.agent.rewindConversation(1)).toBe('change it');
    expect(c.setup.agent.messages).toEqual([]);
  });

  it('stops when the user declines, or continues with their feedback', async () => {
    const c = await start({
      answers: [
        { kind: 'deny', feedback: '' },
        { kind: 'deny', feedback: 'use pnpm instead' },
      ],
      groq: {
        script: {
          main: [
            {
              toolCalls: [
                { name: 'Bash', arguments: '{"command":"npm test"}' },
                { name: 'Bash', arguments: '{"command":"npm run lint"}' },
              ],
            },
            { toolCalls: [{ name: 'Bash', arguments: '{"command":"npm test"}' }] },
            { text: 'OK, I will use pnpm.' },
          ],
        },
      },
    });
    expect((await run(c, 'test it')).status).toBe('declined');
    expect(c.asks).toHaveLength(1); // the second call is skipped, not asked
    const second = await run(c, 'try again');
    expect(second.status).toBe('done');
    const last = bodies(c.groq).at(-1);
    expect(last?.messages.at(-1)).toMatchObject({
      role: 'user',
      content: 'I declined that action. Instead: use pnpm instead',
    });
    expect(last?.messages.filter((m) => m.role === 'tool').map((m) => m.content)).toEqual([
      'The user declined this action.',
      'Not run: the user declined an earlier action in this reply.',
      'The user declined this action.',
    ]);
  });

  it('runs approved commands and remembers "don\'t ask again" rules', async () => {
    const c = await start({
      answers: [{ kind: 'allow_rule', rule: 'Bash(echo:*)', scope: 'session' }],
      groq: {
        script: {
          main: [
            { toolCalls: [{ name: 'Bash', arguments: '{"command":"echo one"}' }] },
            { toolCalls: [{ name: 'Bash', arguments: '{"command":"echo two"}' }] },
            { text: 'done' },
          ],
        },
      },
    });
    await run(c, 'echo twice');
    expect(c.asks.map((a) => [a.label, a.suggestion])).toEqual([['echo one', 'Bash(echo:*)']]);
    const results = c.events.flatMap((e) => (e.type === 'tool_result' ? [e.content] : []));
    expect(results).toEqual(['one', 'two']);
  });

  it('feeds validation errors back so the model can fix its call', async () => {
    const c = await start({
      groq: {
        script: {
          main: [
            {
              toolCalls: [
                { name: 'Read', arguments: '{"path":"a.txt"}' },
                { name: 'Nope', arguments: '{}' },
              ],
            },
            { text: 'Sorry.' },
          ],
        },
      },
    });
    await run(c, 'read');
    const contents = bodies(c.groq)[1]
      ?.messages.filter((m) => m.role === 'tool')
      .map((m) => m.content ?? '');
    expect(contents?.[0]).toMatch(/Invalid arguments for Read:[\s\S]*file_path/);
    expect(contents?.[1]).toMatch(/Unknown tool "Nope"/);
  });

  it('switches a model to the text protocol after a tool_use_failed error', async () => {
    const c = await start({
      files: { 'a.txt': 'text mode works\n' },
      groq: {
        script: {
          main: [
            {
              status: 400,
              error: {
                message: 'Failed to call a function. Please adjust your prompt.',
                code: 'tool_use_failed',
              },
            },
            {
              text: [
                'I will read it.\n<vx:ca',
                'll name="Read">\n{"file_path": "a.txt"}\n</vx:call>',
              ],
            },
            { text: 'It says: text mode works.' },
          ],
        },
      },
    });
    const out = await run(c, 'read a.txt');
    expect(out).toMatchObject({ status: 'done', text: 'It says: text mode works.' });
    const [native, text1, text2] = bodies(c.groq);
    expect(native?.tools).toBeDefined();
    expect(text1?.tools).toBeUndefined();
    expect(text1?.messages[0]?.content).toContain('<vx:call name="Read">');
    expect(text2?.messages.at(-1)?.content).toContain(
      '<vx:result name="Read">\n     1\ttext mode works',
    );
    expect(c.events.some((e) => e.type === 'notice' && e.text.includes('text tool protocol'))).toBe(
      true,
    );
    const visible = c.events.flatMap((e) => (e.type === 'text' ? [e.text] : [])).join('');
    expect(visible).not.toContain('vx:call');
  });

  it('uses the text protocol from the start for models without tool support', async () => {
    const c = await start({
      model: 'openrouter:notools:free',
      openrouter: {
        models: [
          { id: 'notools:free', supported_parameters: [] },
          { id: 'free:free', supported_parameters: ['tools'] },
        ],
        script: { 'notools:free': [{ text: 'No tools needed.' }] },
      },
    });
    await run(c, 'hi');
    expect(bodies(c.openrouter)[0]?.tools).toBeUndefined();
  });

  it('respects --max-turns', async () => {
    const call = { toolCalls: [{ name: 'LS', arguments: '{}' }] };
    const c = await start({ maxTurns: 2, groq: { script: { main: [call, call, call] } } });
    expect(await run(c, 'loop')).toMatchObject({ status: 'max_turns', steps: 2 });
  });

  it('interrupts a running command promptly', async () => {
    const c = await start({
      answers: [{ kind: 'allow' }],
      groq: {
        script: { main: [{ toolCalls: [{ name: 'Bash', arguments: '{"command":"sleep 10"}' }] }] },
      },
    });
    const ac = new AbortController();
    setTimeout(() => {
      ac.abort();
    }, 400);
    const started = Date.now();
    expect((await run(c, 'wait', ac.signal)).status).toBe('interrupted');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('offers only read-only tools in plan mode and switches after the plan is approved', async () => {
    const c = await start({
      groq: {
        script: {
          main: [
            { toolCalls: [{ name: 'ExitPlanMode', arguments: '{"plan":"1. Edit a.txt"}' }] },
            { text: 'Starting.' },
          ],
        },
      },
    });
    c.host.modeValue = 'plan';
    await run(c, 'plan it');
    const [planStep, afterStep] = bodies(c.groq);
    const names = (b: Body | undefined) => b?.tools?.map((t) => t.function.name) ?? [];
    expect(names(planStep)).toContain('ExitPlanMode');
    expect(names(planStep)).not.toContain('Edit');
    expect(planStep?.messages[0]?.content).toContain('Plan mode is on');
    expect(names(afterStep)).toContain('Edit');
    expect(c.host.modeValue).toBe('acceptEdits');
  });
});

describe('Agent recovery', () => {
  it('cancels cleanly while waiting for approval: nothing runs and the turn is interrupted', async () => {
    const c = await start({
      files: { 'a.txt': 'one\n' },
      groq: {
        script: {
          main: [
            {
              toolCalls: [{ name: 'Write', arguments: '{"file_path":"a.txt","content":"two\\n"}' }],
            },
          ],
        },
      },
    });
    const ac = new AbortController();
    let asked = false;
    const host: AgentHost = {
      mode: () => 'default',
      // like the UI: the prompt stays open until answered or the signal aborts
      askPermission: (_req, signal) =>
        new Promise((resolve) => {
          asked = true;
          signal.addEventListener('abort', () => {
            resolve({ kind: 'deny', feedback: '' });
          });
          setTimeout(() => {
            ac.abort();
          }, 50);
        }),
    };
    const events: AgentEvent[] = [];
    const out = await c.setup.agent.run('rewrite a', {
      signal: ac.signal,
      host,
      onEvent: (e) => events.push(e),
    });
    expect(asked).toBe(true);
    expect(out.status).toBe('interrupted');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool_result',
        name: 'Write',
        ok: false,
        summary: 'Interrupted',
      }),
    );
    expect(await fs.readFile(path.join(c.cwd, 'a.txt'), 'utf8')).toBe('one\n');
    // the tool call still has a result, so the next request is well-formed
    const last = c.setup.agent.messages.at(-1);
    expect(last).toMatchObject({ role: 'tool', content: 'Not run: the user interrupted.' });
  });

  it('records what it wrote, so a rewind after an outside edit asks first', async () => {
    const c = await start({
      files: { 'a.txt': 'hello world\n' },
      answers: [{ kind: 'allow' }],
      groq: {
        script: {
          main: [
            { toolCalls: [{ name: 'Read', arguments: '{"file_path":"a.txt"}' }] },
            {
              toolCalls: [
                {
                  name: 'Edit',
                  arguments: '{"file_path":"a.txt","old_string":"world","new_string":"VinaX"}',
                },
              ],
            },
            { text: 'Changed it.' },
          ],
        },
      },
    });
    expect((await run(c, 'change it')).status).toBe('done');
    const file = path.join(c.cwd, 'a.txt');
    expect((await c.setup.checkpoints.planRestore(1)).conflicts).toEqual([]);
    await fs.writeFile(file, 'hello VinaX\nmy own line\n');
    const r = await c.setup.checkpoints.restoreTo(1);
    expect(r.status).toBe('conflicts');
    expect(await fs.readFile(file, 'utf8')).toBe('hello VinaX\nmy own line\n');
    expect((await c.setup.checkpoints.restoreTo(1, { resolution: 'overwrite' })).status).toBe(
      'restored',
    );
    expect(await fs.readFile(file, 'utf8')).toBe('hello world\n');
  });

  it('does not run a change it could not snapshot, and tells the model why', async () => {
    if (process.getuid?.() === 0 || process.platform === 'win32') return;
    const c = await start({
      files: { 'locked.txt': 'x\n' },
      answers: [{ kind: 'allow' }],
      groq: {
        script: {
          main: [
            {
              toolCalls: [
                { name: 'Write', arguments: '{"file_path":"locked.txt","content":"y\\n"}' },
              ],
            },
            { text: 'Could not.' },
          ],
        },
      },
    });
    const file = path.join(c.cwd, 'locked.txt');
    await fs.chmod(file, 0o200); // writable but not readable
    try {
      expect((await run(c, 'overwrite it')).status).toBe('done');
      const result = c.events.find((e) => e.type === 'tool_result');
      expect(result).toMatchObject({ ok: false });
      expect(result?.type === 'tool_result' ? result.content : '').toMatch(/not made/);
      expect(c.setup.checkpoints.changedSince(1)).toEqual([]);
    } finally {
      await fs.chmod(file, 0o644);
    }
    expect(await fs.readFile(file, 'utf8')).toBe('x\n');
  });

  it('drops an unanswered prompt when the provider fails before streaming', async () => {
    const c = await start({
      groq: { script: { main: [{ status: 400, error: { message: 'bad request' } }] } },
      openrouter: { script: { 'free:free': [{ status: 400, error: { message: 'bad too' } }] } },
    });
    const out = await run(c, 'hello');
    expect(out.status).toBe('failed');
    expect(out.report).toBeDefined();
    expect(c.setup.agent.messages).toEqual([]);
    expect(c.setup.agent.turns).toEqual([]);
  });

  it('keeps the partial answer when the stream breaks after output began', async () => {
    const c = await start({
      groq: {
        script: {
          main: [
            {
              text: ['Part one. ', 'Part two. ', 'Never sent.'],
              breakAfterChunks: 2,
              chunkDelayMs: 100,
            },
          ],
        },
      },
    });
    const out = await run(c, 'hello');
    expect(out.status).toBe('failed');
    expect(out.error).toMatch(/stopped mid-response/);
    const last = c.setup.agent.messages.at(-1);
    expect(last?.role).toBe('assistant');
    expect(last?.content).toMatch(/^Part one\. /);
    expect(last?.content).not.toContain('Never sent.');
    // no silent fallback to another model after text was shown
    expect(bodies(c.openrouter)).toEqual([]);
  });
});

describe('Agent control', () => {
  const read = (n: number) => ({
    toolCalls: [{ id: `r${String(n)}`, name: 'Read', arguments: '{"file_path":"missing.txt"}' }],
  });

  it('keeps reported and estimated usage apart, per model', async () => {
    const c = await start({
      groq: {
        script: {
          main: [
            {
              toolCalls: [{ name: 'LS', arguments: '{}' }],
              usage: { prompt_tokens: 100, completion_tokens: 7 },
            },
            { text: 'x'.repeat(400), noUsage: true },
          ],
        },
      },
    });
    const out = await run(c, 'look');
    expect(out.status).toBe('done');
    expect(out.usage).toEqual({ promptTokens: 100, completionTokens: 7 });
    expect(out.estimatedUsage.completionTokens).toBe(100);
    expect(out.estimatedUsage.promptTokens).toBeGreaterThan(0);
    expect(Object.keys(out.usageByModel)).toEqual(['groq:main']);
  });

  it('stops at the token budget before sending a request that would exceed it', async () => {
    const call = {
      toolCalls: [{ name: 'LS', arguments: '{}' }],
      usage: { prompt_tokens: 3000, completion_tokens: 10 },
    };
    const c = await start({
      settings: { budget: { tokens: 5000 } },
      groq: { script: { main: [call, call, call, { text: 'done' }] } },
    });
    const out = await run(c, 'list a lot');
    expect(out.status).toBe('budget');
    expect(out.error).toMatch(/token budget.*5\.0K budget.*--token-budget/s);
    // the second request (3K + ~a few hundred) would pass 5K, so it was never sent
    expect(bodies(c.groq)).toHaveLength(1);
    // the conversation stays well-formed: the tool call has its result
    expect(c.setup.agent.messages.at(-1)?.role).toBe('tool');
  });

  it('stops a task at the time budget, even in the middle of a command', async () => {
    const c = await start({
      settings: { budget: { seconds: 1 }, permissions: { allow: ['Bash(sleep:*)'] } },
      groq: {
        script: { main: [{ toolCalls: [{ name: 'Bash', arguments: '{"command":"sleep 20"}' }] }] },
      },
    });
    const started = Date.now();
    const out = await run(c, 'wait');
    expect(Date.now() - started).toBeLessThan(5000);
    expect(out.status).toBe('budget');
    expect(out.error).toMatch(/time budget.*1s/);
    const result = c.setup.agent.messages.at(-1);
    expect(result).toMatchObject({ role: 'tool' });
    expect(result?.content).toContain('[stopped: the task reached its time budget]');
  });

  it('nudges, then stops a task that repeats a failing call, and explains what to do', async () => {
    const c = await start({
      groq: { script: { main: [read(1), read(2), read(3), { text: 'unreachable' }] } },
    });
    const out = await run(c, 'read it');
    expect(out.status).toBe('stuck');
    expect(out.error).toMatch(/`Read missing\.txt` failed 3 times with the same input/);
    expect(out.error).toContain('Esc Esc to rewind');
    const results = c.setup.agent.messages.filter((m) => m.role === 'tool');
    expect(results[0]?.content).not.toContain('[VinaX:');
    expect(results[1]?.content).toContain('has now failed 2 times');
    expect(bodies(c.groq)).toHaveLength(3);
  });

  it('stops when the same call keeps returning the same result', async () => {
    const ls = (n: number) => ({
      toolCalls: [{ id: `l${String(n)}`, name: 'LS', arguments: '{}' }],
    });
    const c = await start({
      files: { 'a.txt': 'a' },
      groq: { script: { main: [ls(1), ls(2), ls(3), ls(4), ls(5), { text: 'x' }] } },
    });
    const out = await run(c, 'list');
    expect(out.status).toBe('stuck');
    expect(out.error).toMatch(/called 5 times with the same input and returned the same result/);
  });

  it('counts the tokens of a sub-agent towards the task that started it', async () => {
    const c = await start({
      groq: {
        script: {
          main: [
            {
              toolCalls: [
                { name: 'Task', arguments: '{"description":"look","prompt":"Report back."}' },
              ],
              usage: { prompt_tokens: 100, completion_tokens: 10 },
            },
            { text: 'sub-agent report', usage: { prompt_tokens: 40, completion_tokens: 4 } },
            { text: 'All done.', usage: { prompt_tokens: 200, completion_tokens: 20 } },
          ],
        },
      },
    });
    const out = await run(c, 'delegate');
    expect(out.status).toBe('done');
    expect(out.usage).toEqual({ promptTokens: 340, completionTokens: 34 });
  });

  it('says when a model in use cannot call tools natively or is too small for the request', async () => {
    const c = await start({
      groq: {
        models: [{ id: 'main', context_window: 200, supported_parameters: [] }],
        script: { main: [{ text: 'hi' }] },
      },
    });
    await run(c, 'hello');
    const notices = c.events.flatMap((e) => (e.type === 'notice' ? [e.text] : []));
    expect(notices.some((n) => n.includes('groq:main has no native tool calling'))).toBe(true);
    expect(notices.some((n) => /groq:main accepts about 200 tokens/.test(n))).toBe(true);
  });
});

describe('cost', () => {
  const byModel = {
    'openrouter:paid': {
      measured: { promptTokens: 1_000_000, completionTokens: 100_000 },
      estimated: { promptTokens: 0, completionTokens: 0 },
    },
    'groq:main': {
      measured: { promptTokens: 500, completionTokens: 50 },
      estimated: { promptTokens: 0, completionTokens: 0 },
    },
  };

  it('prices only from explicit data and calls the rest unknown', () => {
    const models = new Map([
      [
        'openrouter' as const,
        [
          {
            id: 'paid',
            contextWindow: 1,
            supportsTools: true,
            free: false,
            pricing: { prompt: 0.000001, completion: 0.000002 },
          },
        ],
      ],
    ]);
    const settings = { pricing: {} };
    const price = (ref: string) => priceFor(ref, settings, models);
    const c = costOf(byModel, price);
    expect(c).toEqual({ usd: 1.2, unpriced: ['groq:main'], approximate: false });
    expect(formatCost(c)).toBe('$1.20 + unknown more (no price for groq:main)');
    expect(formatCost(costOf({ 'groq:main': byModel['groq:main'] }, price))).toBe(
      'unknown (no price for groq:main)',
    );
    // settings win over the catalog
    const withSettings = (ref: string) =>
      priceFor(
        ref,
        { pricing: { 'groq:main': { inputPerMillion: 1, outputPerMillion: 2 } } },
        models,
      );
    expect(withSettings('groq:main')).toEqual({
      prompt: 1e-6,
      completion: 2e-6,
      source: 'settings',
    });
    const est = costOf(
      {
        'groq:main': {
          measured: { promptTokens: 0, completionTokens: 0 },
          estimated: { promptTokens: 10, completionTokens: 0 },
        },
      },
      withSettings,
    );
    expect(formatCost(est)).toBe('≈ $0.0000');
  });

  it('reads fixed catalog prices and ignores variable (-1) ones', async () => {
    const server = await startMockServer({
      models: [
        { id: 'fixed', pricing: { prompt: '0.000003', completion: '0.000015' } },
        { id: 'variable', pricing: { prompt: '-1', completion: '-1' } },
      ],
    });
    try {
      const { OpenAICompatibleProvider, RateLimitLedger, noopLogger } =
        await import('../src/index.js');
      const p = new OpenAICompatibleProvider({
        name: 'openrouter',
        baseURL: server.url,
        apiKey: 'k',
        timeoutMs: 2000,
        ledger: new RateLimitLedger(() => 0),
        logger: noopLogger,
        keyCheck: { path: '/key' },
      });
      const list = await p.listModels();
      expect(list.find((m) => m.id === 'fixed')?.pricing).toEqual({
        prompt: 0.000003,
        completion: 0.000015,
      });
      expect(list.find((m) => m.id === 'variable')?.pricing).toBeUndefined();
    } finally {
      await server.close();
    }
  });
});

describe('Agent compaction', () => {
  it('compacts mid-task without losing the image, the tool exchange or the user requests', async () => {
    const png = { mediaType: 'image/png' as const, data: 'iVBORw0KGgo=', name: 'shot.png' };
    const c = await start({
      settings: {
        smallModel: 'groq:small',
        context: { maxTokens: 4000 },
        visionModel: 'groq:main',
      },
      groq: {
        models: [
          { id: 'main', architecture: { input_modalities: ['text', 'image'] } },
          { id: 'small' },
        ],
        script: {
          main: [
            { text: `First answer ${'x'.repeat(6000)}` },
            { toolCalls: [{ id: 't1', name: 'LS', arguments: '{}' }] },
            { text: 'Looked at the screenshot and the folder.' },
          ],
          small: [
            { text: '## Goal\nEarlier work, condensed.' },
            { text: '## Goal\nCondensed again.' },
          ],
        },
      },
    });
    expect((await run(c, 'Never touch the public API. Start.')).status).toBe('done');
    const out = await c.setup.agent.run('What is in this screenshot?', {
      signal: new AbortController().signal,
      host: c.host,
      onEvent: (e) => c.events.push(e),
      images: [png],
    });
    expect(out.status).toBe('done');
    expect(c.events.some((e) => e.type === 'compact' && e.kind === 'summary')).toBe(true);
    const [first, ...rest] = c.setup.agent.messages;
    expect(first).toMatchObject({ role: 'user', images: [png] });
    expect(first?.content).toContain('<conversation-summary>');
    expect(first?.content).toContain('Never touch the public API. Start.');
    expect(first?.content).toMatch(/What is in this screenshot\?$/);
    // the tool call and its result survived together
    expect(rest.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant']);
    // and the image reached the vision model after compaction
    const last = bodies(c.groq).at(-1);
    expect(JSON.stringify(last?.messages[1])).toContain('data:image/png;base64');
  });
});
