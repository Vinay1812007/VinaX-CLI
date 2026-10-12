import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  MCP_STDIO_SERVER,
  startMockMcpHttpServer,
  startMockServer,
  type MockServer,
  type MockServerOptions,
  systemEnv,
} from '@vinax/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addMarketplace,
  AppStateStore,
  createAgentSetup,
  createRuntime,
  detectShell,
  HookRunner,
  htmlToMarkdown,
  loadCustomCommands,
  loadSkills,
  loadMcpConfig,
  loadSubagents,
  installPlugin,
  listPlugins,
  matcherMatches,
  McpManager,
  mcpToolName,
  pluginHooks,
  ReadTracker,
  readPluginConfig,
  removeMarketplace,
  setPluginEnabled,
  ShellSession,
  uninstallPlugin,
  type AgentEvent,
  type AgentHost,
  type AgentSetup,
  type McpServerEntry,
  type ToolContext,
} from '../src/index.js';

let root: string;
let cwd: string;
let home: string;
const cleanups: (() => Promise<void>)[] = [];

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vinax-ext-')));
  cwd = path.join(root, 'project');
  home = path.join(root, 'home');
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(home, { recursive: true });
});
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const write = async (p: string, text: string) => {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, text);
};

const stdioServer = {
  command: process.execPath,
  args: ['--import', import.meta.resolve('tsx'), MCP_STDIO_SERVER],
};

async function setupWith(opts: {
  groq?: MockServerOptions;
  settings?: Record<string, unknown>;
}): Promise<{ setup: AgentSetup; groq: MockServer }> {
  const groq = await startMockServer(opts.groq);
  cleanups.push(() => groq.close());
  await write(
    path.join(home, 'settings.json'),
    JSON.stringify({
      model: 'groq:main',
      smallModel: 'groq:small',
      fallbackChain: [],
      providers: { groq: { baseUrl: groq.url }, openrouter: { enabled: false } },
      router: { maxRetries: 0 },
      ...opts.settings,
    }),
  );
  const env = {
    VINAX_HOME: home,
    VINAX_SECRETS_BACKEND: 'file',
    GROQ_API_KEY: 'gsk_test000000000',
    ...systemEnv(),
  };
  const runtime = await createRuntime({ cwd, env });
  const setup = await createAgentSetup(runtime);
  cleanups.push(() => setup.close());
  return { setup, groq };
}

const allowHost: AgentHost = {
  mode: () => 'default',
  askPermission: () => Promise.resolve({ kind: 'allow' }),
};

async function run(setup: AgentSetup, prompt: string, host: AgentHost = allowHost) {
  const events: AgentEvent[] = [];
  const outcome = await setup.agent.run(prompt, {
    signal: new AbortController().signal,
    host,
    onEvent: (e) => events.push(e),
  });
  return { outcome, events };
}

type Body = {
  model: string;
  messages: { role: string; content: string | null }[];
  tools?: { function: { name: string } }[];
};
const chatBodies = (s: MockServer): Body[] =>
  s.requests.filter((r) => r.path === '/v1/chat/completions').map((r) => r.body as Body);
const call = (name: string, args: Record<string, unknown>) => ({
  name,
  arguments: JSON.stringify(args),
});

describe('HookRunner', () => {
  const runner = (config: ConstructorParameters<typeof HookRunner>[0]) =>
    new HookRunner(config, {
      cwd,
      env: { ...systemEnv() },
      shell: detectShell(),
      disabled: false,
      base: () => ({ session_id: 's1' }),
    });

  it('matches tool names by list or regular expression', () => {
    expect(matcherMatches(undefined, 'Bash')).toBe(true);
    expect(matcherMatches('Edit|Write', 'Write')).toBe(true);
    expect(matcherMatches('Edit, Write', 'Read')).toBe(false);
    expect(matcherMatches('^mcp__.*', 'mcp__github__x')).toBe(true);
    expect(matcherMatches('Bash', undefined)).toBe(false);
  });

  it('passes JSON on stdin and understands exit codes and JSON output', async () => {
    const r = runner({
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: `cat > "${path.join(root, 'in.json')}"` }],
        },
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: `echo '{"additionalContext":"ctx from hook"}'` }],
        },
      ],
      PostToolUse: [
        { hooks: [{ type: 'command', command: 'echo "not allowed: use pnpm" >&2; exit 2' }] },
      ],
      Stop: [{ hooks: [{ type: 'command', command: 'echo oops >&2; exit 1' }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo "plain context"' }] }],
    });
    const pre = await r.run(
      'PreToolUse',
      { tool_name: 'Bash', tool_input: { command: 'ls' } },
      { toolName: 'Bash' },
    );
    expect(pre).toMatchObject({ blocked: false, context: ['ctx from hook'] });
    const stdin = JSON.parse(await fs.readFile(path.join(root, 'in.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(stdin).toMatchObject({
      session_id: 's1',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd,
    });
    expect(await r.run('PreToolUse', {}, { toolName: 'Read' })).toMatchObject({
      blocked: false,
      context: [],
    });
    expect(await r.run('PostToolUse', {}, { toolName: 'Read' })).toMatchObject({
      blocked: true,
      message: 'not allowed: use pnpm',
    });
    expect((await r.run('Stop', {})).warnings[0]).toMatch(/Stop hook failed \(exit 1\).*oops/);
    expect((await r.run('UserPromptSubmit', { prompt: 'x' })).context).toEqual(['plain context']);
    const approve = runner({
      PreToolUse: [{ hooks: [{ type: 'command', command: `echo '{"decision":"approve"}'` }] }],
    });
    expect((await approve.run('PreToolUse', {}, { toolName: 'X' })).approved).toBe(true);
  });
});

describe('hooks in the agent loop', () => {
  it('blocks tool calls, adds post-tool feedback and can reject prompts', async () => {
    const { setup, groq } = await setupWith({
      settings: {
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [{ type: 'command', command: 'echo "Bash is not allowed here" >&2; exit 2' }],
            },
          ],
          PostToolUse: [
            {
              matcher: 'LS',
              hooks: [
                {
                  type: 'command',
                  command: `echo '{"additionalContext":"remember the style guide"}'`,
                },
              ],
            },
          ],
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: 'command',
                  command: `grep -q secret && { echo "no secrets please" >&2; exit 2; } || echo "Today is a test"`,
                },
              ],
            },
          ],
        },
      },
      groq: {
        script: {
          main: [{ toolCalls: [call('Bash', { command: 'ls' }), call('LS', {})] }, { text: 'ok' }],
        },
      },
    });
    const { outcome } = await run(setup, 'list files');
    expect(outcome.status).toBe('done');
    const [first, second] = chatBodies(groq);
    expect(first?.messages[1]?.content).toBe(
      'list files\n\n<hook-context>\nToday is a test\n</hook-context>',
    );
    const toolResults = second?.messages
      .filter((m) => m.role === 'tool')
      .map((m) => m.content ?? '');
    expect(toolResults?.[0]).toBe('Blocked by a PreToolUse hook: Bash is not allowed here');
    expect(toolResults?.[1]).toContain('[PostToolUse hook]\nremember the style guide');

    const blocked = await run(setup, 'here is my secret');
    expect(blocked.outcome).toMatchObject({ status: 'blocked', error: 'no secrets please' });
    expect(chatBodies(groq)).toHaveLength(2);
  });

  it('lets a Stop hook send the model back to work once', async () => {
    const marker = path.join(root, 'stopped-once');
    const { setup, groq } = await setupWith({
      settings: {
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command: `test -f "${marker}" || { touch "${marker}"; echo "run the tests first" >&2; exit 2; }`,
                },
              ],
            },
          ],
        },
      },
      groq: { script: { main: [{ text: 'done early' }, { text: 'tests ran, done' }] } },
    });
    const { outcome, events } = await run(setup, 'fix it');
    expect(outcome).toMatchObject({ status: 'done', text: 'tests ran, done', steps: 2 });
    expect(chatBodies(groq)[1]?.messages.at(-1)?.content).toContain('run the tests first');
    expect(events.some((e) => e.type === 'notice' && e.text.includes('Stop hook'))).toBe(true);
  });
});

describe('MCP', () => {
  it('connects over stdio and streamable HTTP and adapts tools', async () => {
    const httpServer = await startMockMcpHttpServer();
    cleanups.push(() => httpServer.close());
    const manager = new McpManager({ cwd, env: process.env, version: 'test' });
    cleanups.push(() => manager.close());
    const entries: McpServerEntry[] = [
      { name: 'local', scope: 'user', config: stdioServer },
      { name: 'remote', scope: 'user', config: { url: httpServer.url } },
      { name: 'broken', scope: 'user', config: { command: 'definitely-not-a-command-xyz' } },
    ];
    await manager.start(entries, () => Promise.resolve(true));
    const byName = Object.fromEntries(manager.servers.map((s) => [s.name, s]));
    expect(byName.local?.status).toBe('connected');
    expect(byName.remote?.status).toBe('connected');
    expect(byName.broken?.status).toBe('failed');
    expect(
      manager
        .tools()
        .map((t) => t.name)
        .sort(),
    ).toEqual([
      'mcp__local__add',
      'mcp__local__echo',
      'mcp__local__fail',
      'mcp__remote__add',
      'mcp__remote__echo',
      'mcp__remote__fail',
    ]);
    const ctx: ToolContext = {
      cwd,
      workspace: [cwd],
      shell: new ShellSession(detectShell(), cwd, process.env),
      reads: new ReadTracker(),
      signal: new AbortController().signal,
    };
    const tool = (n: string) => manager.tools().find((t) => t.name === n);
    const echo = tool('mcp__remote__echo');
    expect(echo?.readOnly).toBe(true);
    expect(echo?.jsonSchema).toMatchObject({
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    });
    expect(await echo?.run({ text: 'hi' }, ctx)).toMatchObject({ ok: true, content: 'echo: hi' });
    expect(await tool('mcp__local__add')?.run({ a: 2, b: 3 }, ctx)).toMatchObject({
      ok: true,
      content: '5',
    });
    expect(await tool('mcp__local__fail')?.run({}, ctx)).toMatchObject({
      ok: false,
      content: 'something broke',
    });
    expect(mcpToolName('my.server', 'do/thing')).toBe('mcp__my_server__do_thing');
  });

  it('waits for approval of project servers, then exposes their tools to the agent', async () => {
    await write(
      path.join(cwd, '.vinax', 'mcp.json'),
      JSON.stringify({ mcpServers: { demo: stdioServer } }),
    );
    const { setup, groq } = await setupWith({
      groq: {
        script: {
          main: [
            { toolCalls: [call('mcp__demo__echo', { text: 'from model' })] },
            { text: 'Echoed.' },
          ],
        },
      },
    });
    expect(setup.mcp.servers[0]?.status).toBe('needs-approval');
    expect(setup.warnings.join('\n')).toContain('Project MCP server "demo" is not approved yet');
    await setup.approveMcpServer('demo');
    expect(await new AppStateStore({ VINAX_HOME: home }).isMcpApproved(cwd, 'demo')).toBe(true);
    const asks: string[] = [];
    const host: AgentHost = {
      mode: () => 'default',
      askPermission: (req) => {
        asks.push(req.tool);
        return Promise.resolve({ kind: 'allow' });
      },
    };
    await run(setup, 'echo something', host);
    expect(asks).toEqual(['mcp__demo__echo']);
    const [first, second] = chatBodies(groq);
    expect(first?.tools?.map((t) => t.function.name)).toContain('mcp__demo__echo');
    expect(second?.messages.at(-1)?.content).toBe('echo: from model');
  });
});

describe('sub-agents', () => {
  it('loads agent definitions', async () => {
    await write(
      path.join(cwd, '.vinax', 'agents', 'reviewer.md'),
      '---\nname: reviewer\ndescription: Reviews code\ntools: Read, Grep\n---\nYou review code carefully.',
    );
    await write(
      path.join(cwd, '.vinax', 'agents', 'broken.md'),
      '---\nname: broken\n---\nno description',
    );
    const { agents, errors } = await loadSubagents(cwd, { VINAX_HOME: home });
    expect(agents.map((a) => [a.name, a.source, a.tools])).toEqual([
      ['general-purpose', 'builtin', undefined],
      ['reviewer', 'project', ['Read', 'Grep']],
    ]);
    expect(errors[0]).toMatch(/add a description/);
  });

  it('runs a Task in a fresh context with restricted tools and returns only its report', async () => {
    await write(
      path.join(cwd, '.vinax', 'agents', 'reader.md'),
      '---\ndescription: Reads files\ntools: Read\n---\nRead what you are told.',
    );
    await write(path.join(cwd, 'notes.txt'), 'the secret number is 42\n');
    const { setup, groq } = await setupWith({
      groq: {
        script: {
          main: [
            {
              toolCalls: [
                call('Task', {
                  description: 'read notes',
                  prompt: 'Read notes.txt and report the number',
                  subagent_type: 'reader',
                }),
              ],
            },
            { toolCalls: [call('Read', { file_path: 'notes.txt' })] },
            { text: 'The number is 42.' },
            { text: 'The sub-agent found 42.' },
          ],
        },
      },
    });
    const { outcome, events } = await run(setup, 'find the number');
    expect(outcome.text).toBe('The sub-agent found 42.');
    const bodies = chatBodies(groq);
    expect(bodies[1]?.tools?.map((t) => t.function.name)).toEqual(['Read']);
    expect(bodies[1]?.messages[0]?.content).toContain('# Your role: reader sub-agent');
    expect(bodies[1]?.messages[1]?.content).toBe('Read notes.txt and report the number');
    const parentFinal = bodies[3]?.messages ?? [];
    expect(parentFinal.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(parentFinal.at(-1)?.content).toBe('The number is 42.');
    expect(
      events.some((e) => e.type === 'tool_progress' && e.chunk.includes('▸ Read notes.txt')),
    ).toBe(true);
    expect(events.find((e) => e.type === 'tool_result' && e.name === 'Task')).toMatchObject({
      summary: 'Done · 1 tool call',
    });
  });
});

describe('WebFetch', () => {
  it('converts HTML to Markdown, answers with the small model and refuses cross-site redirects', async () => {
    const site = http.createServer((req, res) => {
      if (req.url === '/away') {
        res.writeHead(302, { location: 'https://example.org/elsewhere' });
        res.end();
      } else if (req.url === '/moved') {
        res.writeHead(301, { location: '/docs' });
        res.end();
      } else {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(
          '<html><head><script>evil()</script></head><body><h1>Install</h1><p>Run <code>npm i vinax</code>.</p></body></html>',
        );
      }
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    cleanups.push(
      () =>
        new Promise<void>((r) =>
          site.close(() => {
            r();
          }),
        ),
    );
    const base = `http://127.0.0.1:${String((site.address() as AddressInfo).port)}`;
    expect(htmlToMarkdown('<h2>T</h2><script>x()</script><p>a <b>b</b></p>')).toBe(
      '## T\n\na **b**',
    );

    const { setup, groq } = await setupWith({
      groq: { script: { small: [{ text: 'Use `npm i vinax`.' }] } },
    });
    const tool = setup.tools.find((t) => t.name === 'WebFetch');
    const ctx: ToolContext = {
      cwd,
      workspace: [cwd],
      shell: setup.shell,
      reads: setup.reads,
      signal: new AbortController().signal,
    };
    const httpTool = tool;
    {
      const r = await httpTool?.run({ url: `${base}/moved`, prompt: 'How do I install it?' }, ctx);
      expect(r).toMatchObject({
        ok: true,
        content: expect.stringContaining('Use `npm i vinax`.') as unknown,
      });
      const page = chatBodies(groq)[0]?.messages[1]?.content ?? '';
      expect(page).toContain('# Install');
      expect(page).toContain('Run `npm i vinax`.');
      expect(page).not.toContain('evil');
      const away = await httpTool?.run({ url: `${base}/away`, prompt: 'x' }, ctx);
      expect(away).toMatchObject({ ok: false, summary: 'Redirected to another site' });
      expect(tool?.target({ url: 'https://docs.github.com/x', prompt: 'x' }, ctx)).toEqual({
        domain: 'docs.github.com',
      });
    }
  });
});

describe('output styles', () => {
  it('lists the built-in styles and answers in the default one', async () => {
    const { setup, groq } = await setupWith({ groq: { script: { main: [{ text: 'hi' }] } } });
    expect(setup.outputStyles.map((s) => s.name)).toEqual([
      'default',
      'concise',
      'explanatory',
      'learning',
    ]);
    expect(setup.outputStyle().name).toBe('default');
    await run(setup, 'hello');
    const system = chatBodies(groq)[0]?.messages[0]?.content ?? '';
    expect(system).toContain('Be brief and direct.');
    expect(system).not.toContain('TODO(human)');
  });

  it('writes answers in the style the settings name, without changing how work is done', async () => {
    const { setup, groq } = await setupWith({
      groq: { script: { main: [{ text: 'hi' }] } },
      settings: { outputStyle: 'learning' },
    });
    expect(setup.outputStyle().name).toBe('learning');
    await run(setup, 'hello');
    const system = chatBodies(groq)[0]?.messages[0]?.content ?? '';
    expect(system).toContain('TODO(human)');
    expect(system).not.toContain('Be brief and direct.');
    // the style replaces the answering rules only; the working rules are still there
    expect(system).toContain('Read a file before editing it.');
    expect(system).toContain('Never invent command output or test results.');
  });

  it('loads styles from the project and the user, project first, and takes effect on the next turn', async () => {
    await write(
      path.join(home, 'output-styles', 'house.md'),
      '---\nname: house\ndescription: The user copy\n---\nAnswer like the user file.',
    );
    await write(
      path.join(cwd, '.vinax', 'output-styles', 'house.md'),
      '---\nname: House\ndescription: The project copy\n---\nAnswer like the project file.',
    );
    const { setup, groq } = await setupWith({
      groq: { script: { main: [{ text: 'a' }, { text: 'b' }] } },
    });
    const house = setup.outputStyles.find((s) => s.name === 'house');
    expect(house).toMatchObject({ description: 'The project copy', source: 'project' });
    // a body with no heading of its own still lands as the answering section
    expect(house?.prompt).toBe('# Answering\nAnswer like the project file.');

    await run(setup, 'first');
    expect(chatBodies(groq)[0]?.messages[0]?.content).toContain('Be brief and direct.');
    expect(setup.setOutputStyle('house')).toBe(true);
    expect(setup.setOutputStyle('nope')).toBe(false);
    await run(setup, 'second');
    const system = chatBodies(groq).at(-1)?.messages[0]?.content ?? '';
    expect(system).toContain('Answer like the project file.');
    expect(system).not.toContain('Be brief and direct.');
  });

  it('explains a style file it cannot use, and a style setting that names nothing', async () => {
    await write(path.join(cwd, '.vinax', 'output-styles', 'empty.md'), '---\nname: empty\n---\n');
    await write(
      path.join(cwd, '.vinax', 'output-styles', 'bad.md'),
      '---\nname: Not A Name!\n---\nBody.',
    );
    const { setup } = await setupWith({ settings: { outputStyle: 'missing' } });
    expect(setup.warnings.join('\n')).toContain('empty.md: the file has no instructions');
    expect(setup.warnings.join('\n')).toContain('bad.md: style names may only use');
    expect(setup.warnings.join('\n')).toContain(
      'Unknown output style "missing" in settings; answering in "default" instead.',
    );
    expect(setup.outputStyle().name).toBe('default');
  });
});

describe('plugins', () => {
  /** A local marketplace with one plugin that contributes one of everything. */
  async function marketplace(): Promise<string> {
    const dir = path.join(root, 'market');
    await write(
      path.join(dir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'house',
        plugins: [{ name: 'toolkit', source: './toolkit', description: 'Our house toolkit' }],
      }),
    );
    const p = path.join(dir, 'toolkit');
    await write(
      path.join(p, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'toolkit', description: 'Our house toolkit', version: '1.2.0' }),
    );
    await write(
      path.join(p, 'commands', 'ship.md'),
      '---\ndescription: Ship it\n---\nShip $ARGUMENTS.',
    );
    await write(
      path.join(p, 'agents', 'auditor.md'),
      '---\nname: auditor\ndescription: Audits things\n---\nBe thorough.',
    );
    await write(
      path.join(p, 'skills', 'release', 'SKILL.md'),
      '---\nname: release\ndescription: How we cut a release\n---\nTag, then publish.',
    );
    await write(
      path.join(p, 'hooks', 'hooks.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: 'command', command: 'echo ${CLAUDE_PLUGIN_ROOT}/greet.sh' }] },
          ],
        },
      }),
    );
    return dir;
  }

  it('installs a plugin from a marketplace and loads everything it contributes', async () => {
    const dir = await marketplace();
    const env = { VINAX_HOME: home, ...systemEnv() };
    const added = await addMarketplace(env, dir);
    expect(added).toMatchObject({ name: 'house' });
    const installed = await installPlugin(env, 'toolkit', 'house');
    expect(installed).toMatchObject({ plugin: { id: 'toolkit@house', enabled: true } });

    const { setup } = await setupWith({});
    expect(setup.skills.find((s) => s.name === 'release')).toMatchObject({ source: 'plugin' });
    expect(setup.subagents.find((a) => a.name === 'auditor')).toMatchObject({ source: 'plugin' });
    const { commands } = await loadCustomCommands(cwd, env);
    expect(commands.find((c) => c.name === 'ship')).toMatchObject({ scope: 'plugin' });
    // a plugin cannot know where it was installed, so ${CLAUDE_PLUGIN_ROOT} is filled in for it
    const hook = pluginHooks(env).hooks.SessionStart?.[0]?.hooks[0]?.command ?? '';
    expect(hook).toBe(
      `echo ${path.join(home, 'plugins', 'installed', 'house', 'toolkit')}/greet.sh`,
    );
  });

  it('stops contributing when disabled, and leaves nothing behind when uninstalled', async () => {
    const dir = await marketplace();
    const env = { VINAX_HOME: home, ...systemEnv() };
    await addMarketplace(env, dir);
    await installPlugin(env, 'toolkit', 'house');

    await setPluginEnabled(env, 'toolkit@house', false);
    expect((await loadSkills(cwd, env)).skills.find((s) => s.name === 'release')).toBeUndefined();
    expect(pluginHooks(env).hooks.SessionStart).toBeUndefined();
    expect(listPlugins(env)[0]).toMatchObject({ enabled: false, missing: false });

    await setPluginEnabled(env, 'toolkit@house', true);
    expect((await loadSkills(cwd, env)).skills.find((s) => s.name === 'release')).toBeDefined();

    await uninstallPlugin(env, 'toolkit@house');
    expect(listPlugins(env)).toEqual([]);
    expect((await loadSkills(cwd, env)).skills.find((s) => s.name === 'release')).toBeUndefined();
  });

  it('refuses a folder that is not a marketplace, and a plugin the marketplace does not have', async () => {
    const env = { VINAX_HOME: home, ...systemEnv() };
    const missing = await addMarketplace(env, path.join(root, 'nope'));
    expect('error' in missing && missing.error).toContain('does not exist');
    await fs.mkdir(path.join(root, 'plain'), { recursive: true });
    const plain = await addMarketplace(env, path.join(root, 'plain'));
    expect('error' in plain && plain.error).toContain('has no .vinax-plugin/marketplace.json');
    await addMarketplace(env, await marketplace());
    expect(await installPlugin(env, 'missing', 'house')).toMatchObject({
      error: '"house" has no plugin called "missing".',
    });
    // nothing was installed, so nothing is listed
    expect(listPlugins(env)).toEqual([]);
  });

  it('loses a name clash with your own command, agent or skill', async () => {
    const env = { VINAX_HOME: home, ...systemEnv() };
    await addMarketplace(env, await marketplace());
    await installPlugin(env, 'toolkit', 'house');
    await write(path.join(home, 'commands', 'ship.md'), '---\ndescription: Mine\n---\nMine.');
    await write(
      path.join(cwd, '.vinax', 'agents', 'auditor.md'),
      '---\nname: auditor\ndescription: Mine\n---\nMine.',
    );
    await write(
      path.join(cwd, '.vinax', 'skills', 'release', 'SKILL.md'),
      '---\nname: release\ndescription: Mine\n---\nMine.',
    );
    const { commands } = await loadCustomCommands(cwd, env);
    expect(commands.find((c) => c.name === 'ship')).toMatchObject({ scope: 'user' });
    const { agents } = await loadSubagents(cwd, env);
    expect(agents.find((a) => a.name === 'auditor')).toMatchObject({ source: 'project' });
    const { skills } = await loadSkills(cwd, env);
    expect(skills.find((x) => x.name === 'release')).toMatchObject({ source: 'project' });
  });

  it('starts the MCP servers of a plugin from where the plugin was installed', async () => {
    const env = { VINAX_HOME: home, ...systemEnv() };
    const dir = await marketplace();
    await write(
      path.join(dir, 'toolkit', '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          kit: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.js'] },
        },
      }),
    );
    await addMarketplace(env, dir);
    await installPlugin(env, 'toolkit', 'house');
    const { servers } = await loadMcpConfig(cwd, env);
    const kit = servers.find((x) => x.name === 'kit');
    expect(kit?.scope).toBe('plugin');
    expect(kit?.config).toMatchObject({
      args: [path.join(home, 'plugins', 'installed', 'house', 'toolkit', 'server.js')],
    });
  });

  it('removing a marketplace uninstalls what came from it', async () => {
    const env = { VINAX_HOME: home, ...systemEnv() };
    await addMarketplace(env, await marketplace());
    await installPlugin(env, 'toolkit', 'house');
    expect(await removeMarketplace(env, 'house')).toEqual({ removed: 1 });
    expect(listPlugins(env)).toEqual([]);
    expect(readPluginConfig(env).marketplaces).toEqual({});
  });
});
