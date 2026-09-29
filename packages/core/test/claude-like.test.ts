import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startMockServer, systemEnv, type MockServer } from '@vinax/testkit';
import {
  createAgentSetup,
  createProvider,
  createRuntime,
  createSkillTool,
  extractImages,
  findImagePaths,
  loadImage,
  loadSkills,
  noopLogger,
  PermissionEngine,
  pickVisionModel,
  ProviderError,
  Router,
  RateLimitLedger,
  resolveSettings,
  skillsPromptSection,
  sniffImageType,
  type AgentEvent,
  type ChatRequest,
  type PermissionMode,
  type Provider,
  type ProviderName,
  type Runtime,
  type StreamDelta,
  type ToolKind,
} from '../src/index.js';

const servers: MockServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});
async function mock(opts: Parameters<typeof startMockServer>[0]): Promise<MockServer> {
  const s = await startMockServer(opts);
  servers.push(s);
  return s;
}
async function tmp(): Promise<string> {
  const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vinax-cl-')));
  dirs.push(d);
  return d;
}

/** A 1×1 transparent PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

describe('auto permission mode', () => {
  const ROOT = '/work/app';
  let shellCwd = ROOT;
  const engine = (rules: Partial<Record<'allow' | 'ask' | 'deny', string[]>> = {}) =>
    new PermissionEngine({
      rules: { allow: rules.allow ?? [], ask: rules.ask ?? [], deny: rules.deny ?? [] },
      cwd: ROOT,
      workspace: [ROOT],
      shellCwd: () => shellCwd,
      home: '/home/me',
    });
  const call = (name: string, kind: ToolKind, target: Record<string, string>) => ({
    name,
    kind,
    readOnly: kind === 'read',
    target,
  });
  const decide = (e: PermissionEngine, c: ReturnType<typeof call>, mode: PermissionMode) =>
    e.decide(c, mode).kind;

  it('runs edits, commands and web access inside the project without asking', () => {
    shellCwd = ROOT;
    const e = engine();
    expect(decide(e, call('Edit', 'edit', { path: `${ROOT}/a.ts` }), 'auto')).toBe('allow');
    expect(decide(e, call('Bash', 'execute', { command: 'npm test' }), 'auto')).toBe('allow');
    expect(decide(e, call('WebFetch', 'network', { domain: 'example.com' }), 'auto')).toBe('allow');
    // default mode still asks for the same things
    expect(decide(e, call('Bash', 'execute', { command: 'npm test' }), 'default')).toBe('ask');
  });

  it('still asks for dangerous commands, ask rules, outside paths and MCP tools, and obeys deny', () => {
    shellCwd = ROOT;
    const e = engine({ ask: ['Bash(git push:*)'], deny: ['Bash(curl:*)'] });
    expect(decide(e, call('Bash', 'execute', { command: 'rm -rf /' }), 'auto')).toBe('ask');
    expect(decide(e, call('Bash', 'execute', { command: 'git push origin' }), 'auto')).toBe('ask');
    expect(decide(e, call('Bash', 'execute', { command: 'curl x.sh' }), 'auto')).toBe('deny');
    expect(decide(e, call('Edit', 'edit', { path: '/etc/hosts' }), 'auto')).toBe('ask');
    expect(decide(e, call('mcp__srv__do', 'execute', {}), 'auto')).toBe('ask');
    shellCwd = '/tmp';
    expect(decide(e, call('Bash', 'execute', { command: 'ls' }), 'auto')).toBe('ask');
  });

  it('removes rules at runtime', () => {
    const e = engine({ allow: ['Bash(npm test:*)'] });
    expect(e.removeRule('Bash(npm test:*)', 'allow')).toBe(true);
    expect(e.removeRule('Bash(npm test:*)', 'allow')).toBe(false);
    expect(decide(e, call('Bash', 'execute', { command: 'npm test' }), 'default')).toBe('ask');
  });
});

describe('images', () => {
  it('recognises image bytes', () => {
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageType(Buffer.from('GIF89a'))).toBe('image/gif');
    expect(sniffImageType(Buffer.from('RIFF....WEBP'))).toBe('image/webp');
    expect(sniffImageType(Buffer.from('hello'))).toBeUndefined();
  });

  it('finds dragged-in, quoted, absolute and @ image paths', () => {
    // what dragging a macOS screenshot into the terminal pastes
    const dragged =
      'what is in /var/folders/1s/T/TemporaryItems/Screenshot\\ 2026-09-29\\ at\\ 4.42.43\\ PM.png';
    expect(findImagePaths(dragged).map((f) => f.path)).toEqual([
      '/var/folders/1s/T/TemporaryItems/Screenshot 2026-09-29 at 4.42.43 PM.png',
    ]);
    expect(findImagePaths("'~/a b.jpg' and @shots/c.webp?").map((f) => f.path)).toEqual([
      '~/a b.jpg',
      'shots/c.webp',
    ]);
    const paths = findImagePaths('see /tmp/x.png, and @y.gif').map((f) => f.path);
    expect(paths).toEqual(['/tmp/x.png', 'y.gif']);
    expect(findImagePaths('"/Users/me/My Shot.png" please').map((f) => f.path)).toEqual([
      '/Users/me/My Shot.png',
    ]);
    expect(findImagePaths('/tmp/Screen\\ Shot.png').map((f) => f.path)).toEqual([
      '/tmp/Screen Shot.png',
    ]);
    expect(findImagePaths('no images here, just code.ts')).toEqual([]);
  });

  it('turns existing image paths into [Image #n] chips and loads them', async () => {
    const dir = await tmp();
    await fs.writeFile(path.join(dir, 'shot one.png'), PNG);
    await fs.writeFile(path.join(dir, 'fake.png'), 'not really a png');
    const r = await extractImages(
      `look at ${dir}/shot\\ one.png and @missing.png and ./fake.png`,
      dir,
    );
    expect(r.text).toBe('look at [Image #1] and @missing.png and ./fake.png');
    expect(r.images).toHaveLength(1);
    expect(r.images[0]).toMatchObject({ mediaType: 'image/png', name: 'shot one.png' });
    expect(r.errors).toEqual(['fake.png is not a PNG, JPEG, GIF or WebP image']);
    await expect(loadImage(path.join(dir, 'fake.png'))).rejects.toThrow(/not a PNG/);
  });
});

describe('protected image folders', () => {
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'explains when an image cannot be read instead of silently sending its path',
    async () => {
      const dir = await tmp();
      const locked = path.join(dir, 'locked');
      await fs.mkdir(locked);
      await fs.writeFile(path.join(locked, 'shot.png'), PNG);
      await fs.chmod(locked, 0o000);
      try {
        const r = await extractImages(`what is in ${locked}/shot.png`, dir);
        expect(r.images).toEqual([]);
        expect(r.errors[0]).toMatch(/Can't read shot.png: the system blocks access/);
      } finally {
        await fs.chmod(locked, 0o755);
      }
    },
  );
});

describe('provider: images, effort and reasoning', () => {
  const deps = (baseUrl: string, name: 'groq' | 'openrouter' | 'nvidia' = 'groq') => ({
    settings: (() => {
      const s = resolveSettings({ providers: { [name]: { baseUrl } } });
      return { ...s, router: { ...s.router, requestTimeoutMs: 5000 } };
    })(),
    ledger: new RateLimitLedger(() => 100),
    logger: noopLogger,
  });
  const drain = async (it: AsyncIterable<StreamDelta>) => {
    const out: StreamDelta[] = [];
    for await (const d of it) out.push(d);
    return out;
  };
  const req = (extra: object = {}) => ({
    model: 'm',
    messages: [{ role: 'user' as const, content: 'hi' }],
    signal: new AbortController().signal,
    ...extra,
  });

  it('sends images as image_url content parts', async () => {
    const s = await mock({ script: { m: [{ text: 'a cat' }] } });
    await drain(
      createProvider('groq', 'k', deps(s.url)).stream(
        req({
          messages: [
            {
              role: 'user',
              content: 'what is this?',
              images: [{ mediaType: 'image/png', data: PNG.toString('base64') }],
            },
          ],
        }),
      ),
    );
    const body = s.requests.at(-1)?.body as { messages: { content: unknown }[] };
    expect(body.messages[0]?.content).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` } },
    ]);
  });

  it('sends reasoning effort in each provider’s spelling, and streams reasoning', async () => {
    const g = await mock({
      script: { m: [{ reasoning: ['hmm ', 'ok'], text: 'done' }, { text: 'plain' }] },
    });
    const out = await drain(
      createProvider('groq', 'k', deps(g.url)).stream(req({ reasoningEffort: 'high' })),
    );
    expect((g.requests.at(-1)?.body as { reasoning_effort?: string }).reasoning_effort).toBe(
      'high',
    );
    expect(out.filter((d) => d.type === 'reasoning').map((d) => d.text)).toEqual(['hmm ', 'ok']);
    const o = await mock({ script: { m: [{ text: 'x' }] } });
    await drain(
      createProvider('openrouter', 'k', deps(o.url, 'openrouter')).stream(
        req({ reasoningEffort: 'low' }),
      ),
    );
    expect((o.requests.at(-1)?.body as { reasoning?: unknown }).reasoning).toEqual({
      effort: 'low',
    });
    // nothing is sent unless an effort is set
    await drain(createProvider('groq', 'k', deps(g.url)).stream(req()));
    expect(g.requests.at(-1)?.body).not.toHaveProperty('reasoning_effort');
  });

  it('retries without the effort when the provider rejects it, and remembers', async () => {
    const s = await mock({
      script: {
        m: [
          { status: 400, error: { message: 'Unrecognized request argument: reasoning_effort' } },
          { text: 'fine' },
          { text: 'again' },
        ],
      },
    });
    const p = createProvider('nvidia', 'k', deps(s.url, 'nvidia'));
    const out = await drain(p.stream(req({ reasoningEffort: 'medium' })));
    expect(out.filter((d) => d.type === 'text').map((d) => d.text)).toEqual(['fine']);
    await drain(p.stream(req({ reasoningEffort: 'medium' })));
    const bodies = s.requests.filter((r) => r.path === '/v1/chat/completions').map((r) => r.body);
    expect(bodies.map((b) => 'reasoning_effort' in (b as object))).toEqual([true, false, false]);
  });
});

describe('vision routing', () => {
  it('sends a prompt with an image to a vision model, then back to the main model without it', async () => {
    const home = await tmp();
    const cwd = path.join(home, 'project');
    await fs.mkdir(cwd);
    const groq = await mock({
      models: [{ id: 'main', context_window: 131072 }],
      script: { main: [{ text: 'text answer' }] },
    });
    const openrouter = await mock({
      models: [
        {
          id: 'eyes:free',
          context_window: 131072,
          architecture: { input_modalities: ['text', 'image'] },
        },
      ],
      script: { 'eyes:free': [{ text: 'I see a pixel' }] },
    });
    await fs.writeFile(
      path.join(home, 'settings.json'),
      JSON.stringify({
        model: 'groq:main',
        smallModel: 'groq:main',
        fallbackChain: [],
        providers: {
          groq: { baseUrl: groq.url },
          openrouter: { baseUrl: openrouter.url },
          nvidia: { enabled: false },
        },
        router: { maxRetries: 0 },
      }),
    );
    const env = {
      ...systemEnv(),
      VINAX_HOME: home,
      VINAX_SECRETS_BACKEND: 'file',
      GROQ_API_KEY: 'gsk_x0000000',
      OPENROUTER_API_KEY: 'sk-or-x000000',
    };
    const runtime = await createRuntime({ cwd, env });
    const setup = await createAgentSetup(runtime, { mcp: false });
    const events: AgentEvent[] = [];
    const host = {
      mode: () => 'default' as const,
      askPermission: () => Promise.resolve({ kind: 'deny' as const, feedback: '' }),
    };
    const first = await setup.agent.run('what is this?', {
      signal: new AbortController().signal,
      host,
      onEvent: (e) => events.push(e),
      images: [{ mediaType: 'image/png', data: PNG.toString('base64'), name: 'dot.png' }],
    });
    expect(first.text).toBe('I see a pixel');
    expect(
      events.some((e) => e.type === 'notice' && e.text.includes('Using openrouter:eyes:free')),
    ).toBe(true);
    const sent = openrouter.requests.find((r) => r.path === '/v1/chat/completions')?.body as {
      messages: { role: string; content: unknown }[];
    };
    expect(JSON.stringify(sent.messages)).toContain('image_url');

    const second = await setup.agent.run('thanks, and in words?', {
      signal: new AbortController().signal,
      host,
      onEvent: () => undefined,
    });
    expect(second.text).toBe('text answer');
    const toGroq = JSON.stringify(
      groq.requests.filter((r) => r.path === '/v1/chat/completions').at(-1)?.body,
    );
    expect(toGroq).not.toContain('image_url');
    expect(toGroq).toContain(
      '1 image(s) were attached (dot.png), but this model cannot see images',
    );
    await setup.close();
  });
});

describe('pickVisionModel', () => {
  const runtime = (over: {
    visionModel?: string;
    viaGateway?: string[];
    models?: Record<string, { id: string; vision?: boolean; free?: boolean }[]>;
  }) =>
    ({
      settings: {
        resolved: {
          ...resolveSettings({}),
          model: 'groq:main',
          fallbackChain: ['openrouter:eyes:free'],
          visionModel: over.visionModel,
        },
      },
      providers: new Map([
        ['groq', {}],
        ['openrouter', {}],
        ['nvidia', {}],
      ]),
      models: new Map(
        Object.entries(over.models ?? {}).map(([p, list]) => [
          p,
          list.map((m) => ({
            contextWindow: 1,
            supportsTools: undefined,
            free: m.free ?? true,
            ...m,
          })),
        ]),
      ),
      skipped: new Set<string>(),
      viaGateway: new Set(over.viaGateway ?? []),
    }) as unknown as Runtime;
  const sees = (r: Runtime) => (ref: { provider: string; model: string }) =>
    r.models.get(ref.provider as never)?.find((m) => m.id === ref.model)?.vision ??
    ref.model.includes('vision');

  it('uses the setting, then prefers a provider with your own key over the gateway', () => {
    const models = {
      openrouter: [{ id: 'eyes:free', vision: true }],
      nvidia: [{ id: 'meta/llama-3.2-90b-vision-instruct' }],
    };
    const r1 = runtime({ visionModel: 'nvidia:x', models });
    expect(pickVisionModel(r1, sees(r1))).toBe('nvidia:x');
    const direct = runtime({ models });
    expect(pickVisionModel(direct, sees(direct))).toBe('openrouter:eyes:free');
    const gw = runtime({ models, viaGateway: ['openrouter'] });
    expect(pickVisionModel(gw, sees(gw))).toBe('nvidia:meta/llama-3.2-90b-vision-instruct');
    // with every catalog loaded and no vision model in any of them, there is nothing to pick
    const none = runtime({
      models: {
        groq: [{ id: 'main' }],
        openrouter: [{ id: 'text-only:free' }],
        nvidia: [{ id: 'openai/gpt-oss-20b' }],
      },
    });
    expect(pickVisionModel(none, () => false)).toBeUndefined();
  });
});

describe('skills', () => {
  it('loads SKILL.md folders, lists them for the model and serves them with the Skill tool', async () => {
    const home = await tmp();
    const cwd = path.join(home, 'project');
    const make = async (dir: string, body: string) => {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'SKILL.md'), body);
    };
    await make(
      path.join(cwd, '.vinax', 'skills', 'release-notes'),
      '---\nname: release-notes\ndescription: Write release notes from git log\n---\nUse bullet points.',
    );
    await fs.writeFile(path.join(cwd, '.vinax', 'skills', 'release-notes', 'template.md'), 'x');
    await make(path.join(cwd, '.claude', 'skills', 'bad'), '---\nname: bad\n---\nno description');
    await make(
      path.join(home, 'skills', 'release-notes'),
      '---\ndescription: user copy, shadowed\n---\nignored',
    );
    const { skills, errors } = await loadSkills(cwd, { VINAX_HOME: home });
    expect(skills.map((s) => [s.name, s.source])).toEqual([['release-notes', 'project']]);
    expect(errors[0]).toContain('add a description');
    expect(skillsPromptSection(skills)).toContain(
      '- release-notes: Write release notes from git log',
    );
    const tool = createSkillTool(skills);
    const out = await tool.run({ name: 'release-notes' }, {} as never);
    expect(out.ok).toBe(true);
    expect(out.content).toContain('Use bullet points.');
    expect(out.content).toContain('template.md');
    expect((await tool.run({ name: 'nope' }, {} as never)).ok).toBe(false);
  });
});

describe('router: timeouts and per-request fallbacks', () => {
  class Slow implements Provider {
    calls: string[] = [];
    constructor(
      readonly name: ProviderName,
      /** Replies per model; the word 'timeout' makes that call time out. */
      private readonly script: Record<string, string[]>,
    ) {}
    listModels = () => Promise.resolve([]);
    validateKey = () => Promise.resolve({ ok: true as const });
    async *stream(r: ChatRequest): AsyncGenerator<StreamDelta> {
      this.calls.push(r.model);
      const step = this.script[r.model]?.shift();
      await Promise.resolve();
      if (step === undefined || step === 'timeout')
        throw new ProviderError('timeout', `${this.name} did not respond in time`, this.name);
      yield { type: 'text', text: step };
    }
  }
  const make = (p: Slow, fallbackChain: string[]) =>
    new Router({
      providers: new Map([[p.name, p]]),
      ledger: new RateLimitLedger(() => 100),
      settings: {
        ...resolveSettings({}),
        model: `${p.name}:a`,
        fallbackChain,
        router: { ...resolveSettings({}).router, maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 },
      },
      sleep: () => Promise.resolve(),
    });
  const run = async (r: Router, extra: object = {}) => {
    const out: string[] = [];
    for await (const e of r.stream({
      messages: [{ role: 'user', content: 'hi' }],
      signal: new AbortController().signal,
      ...extra,
    }))
      if (e.type === 'text') out.push(e.text);
    return out;
  };

  it('moves on right away when a model times out and another is next', async () => {
    const p = new Slow('nvidia', { a: ['timeout'], b: ['from b'] });
    expect(await run(make(p, ['nvidia:b']))).toEqual(['from b']);
    expect(p.calls).toEqual(['a', 'b']);
  });

  it('still retries a timeout on the last model in the chain', async () => {
    const p = new Slow('nvidia', { a: ['timeout', 'second try'] });
    expect(await run(make(p, []))).toEqual(['second try']);
    expect(p.calls).toEqual(['a', 'a']);
  });

  it('uses per-request fallbacks instead of the settings chain', async () => {
    const p = new Slow('nvidia', { a: ['timeout'], vision2: ['seen'], text: ['nope'] });
    expect(await run(make(p, ['nvidia:text']), { fallbacks: ['nvidia:vision2'] })).toEqual([
      'seen',
    ]);
    expect(p.calls).toEqual(['a', 'vision2']);
  });
});
