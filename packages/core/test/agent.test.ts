import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startMockServer, type MockServer, type MockServerOptions } from '@vinax/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createAgentSetup,
  createRuntime,
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
  await fs.rm(ctx.root, { recursive: true, force: true });
  ctx = undefined;
});

async function start(opts: {
  groq?: MockServerOptions;
  openrouter?: MockServerOptions;
  answers?: PermissionAnswer[];
  model?: string;
  maxTurns?: number;
  files?: Record<string, string>;
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
    }),
  );
  const env = {
    VINAX_HOME: home,
    VINAX_SECRETS_BACKEND: 'file',
    GROQ_API_KEY: 'gsk_test00000000',
    OPENROUTER_API_KEY: 'sk-or-v1-test0000',
    PATH: process.env.PATH,
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
    expect(results).toEqual([
      ['Read', true, 'Read 1 line'],
      ['Grep', true, 'Found 1 file'],
    ]);
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
