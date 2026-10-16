import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildSystemPrompt,
  bwrapArgs,
  bypassRefusal,
  createSandbox,
  createToolset,
  createWebSearchTool,
  detectShell,
  isReadOnlyCommand,
  parseDuckDuckGoHtml,
  PermissionEngine,
  pickSearchProvider,
  ProjectMemory,
  ReadTracker,
  resolveSettings,
  sandboxRefusal,
  seatbeltProfile,
  settingsSchema,
  ShellSession,
  TodoStore,
  unwrapDuckDuckGoUrl,
  webSearch,
  writableRoots,
  type PermissionMode,
  type ToolContext,
  type ToolKind,
} from '../src/index.js';

const dirs: string[] = [];
const shells: ShellSession[] = [];
afterEach(async () => {
  for (const s of shells.splice(0)) s.killAll();
  await Promise.all(
    dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true, maxRetries: 5 })),
  );
});
async function tmp(): Promise<string> {
  const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vinax-parity-')));
  dirs.push(d);
  return d;
}

describe('read-only commands', () => {
  it('recognises commands that only read', () => {
    for (const c of [
      'ls -la',
      'cat a.txt | head -5',
      'grep -rn foo src',
      'git status',
      'git log --oneline -5',
      'git diff HEAD~1 -- src',
      'git -C sub show HEAD',
      'git branch -a',
      'git stash list',
      'find . -name "*.ts"',
      'rg TODO 2>/dev/null',
      'wc -l *.ts && pwd',
    ])
      expect(isReadOnlyCommand(c), c).toBe(true);
  });

  it('treats writes, unknown programs and tricks as not read-only', () => {
    for (const c of [
      'npm test',
      'rm -rf build',
      'echo hi > out.txt',
      'cat a >> b',
      'git commit -m x',
      'git branch new-feature',
      'git checkout main',
      'git -c core.pager=evil log',
      'git diff --output=patch.txt',
      'find . -delete',
      'find . -exec rm {} ;',
      'sort -o out.txt in.txt',
      'cat $(which evil)',
      'ls `rm -rf x`',
      'PAGER=evil git log',
      'ls && touch x',
      'sed -i s/a/b/ f',
      '',
    ])
      expect(isReadOnlyCommand(c), c).toBe(false);
  });
});

describe('readOnly and bypass permission modes', () => {
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
    readOnly: kind === 'read' || kind === 'network',
    target,
  });
  const decide = (e: PermissionEngine, c: ReturnType<typeof call>, mode: PermissionMode) =>
    e.decide(c, mode);

  it('read-only mode refuses edits and writing commands without asking', () => {
    shellCwd = ROOT;
    const e = engine({ allow: ['Edit', 'Bash(npm test:*)'] });
    const edit = decide(e, call('Edit', 'edit', { path: `${ROOT}/a.ts` }), 'readOnly');
    expect(edit.kind).toBe('deny');
    expect(edit.reason).toContain('Read-only mode');
    // even an allow rule does not let a writing command through
    expect(decide(e, call('Bash', 'execute', { command: 'npm test' }), 'readOnly').kind).toBe(
      'deny',
    );
    expect(decide(e, call('mcp__srv__do', 'execute', {}), 'readOnly').kind).toBe('deny');
  });

  it('read-only mode runs read-only commands inside the project, and reads as usual', () => {
    shellCwd = ROOT;
    const e = engine();
    expect(decide(e, call('Bash', 'execute', { command: 'git status' }), 'readOnly').kind).toBe(
      'allow',
    );
    expect(decide(e, call('Read', 'read', { path: `${ROOT}/a.ts` }), 'readOnly').kind).toBe(
      'allow',
    );
    // outside the project it still asks
    expect(decide(e, call('Bash', 'execute', { command: 'cat /etc/hosts' }), 'readOnly').kind).toBe(
      'ask',
    );
    expect(decide(e, call('Read', 'read', { path: '/etc/hosts' }), 'readOnly').kind).toBe('ask');
    shellCwd = '/tmp';
    expect(decide(e, call('Bash', 'execute', { command: 'ls' }), 'readOnly').kind).toBe('ask');
    // the same command asks in manual mode
    shellCwd = ROOT;
    expect(decide(e, call('Bash', 'execute', { command: 'git status' }), 'default').kind).toBe(
      'ask',
    );
  });

  it('bypass mode approves everything except deny rules', () => {
    shellCwd = '/tmp';
    const e = engine({ deny: ['Bash(curl:*)'], ask: ['Bash(git push:*)'] });
    for (const c of [
      call('Bash', 'execute', { command: 'rm -rf build' }),
      call('Bash', 'execute', { command: 'git push origin main' }),
      call('Edit', 'edit', { path: '/etc/hosts' }),
      call('WebFetch', 'network', { domain: 'example.com' }),
      call('mcp__srv__do', 'execute', {}),
    ])
      expect(decide(e, c, 'bypass').kind, c.name).toBe('allow');
    expect(decide(e, call('Bash', 'execute', { command: 'curl x' }), 'bypass').kind).toBe('deny');
  });

  it('refuses bypass as root unless explicitly allowed', () => {
    expect(bypassRefusal({}, 501)).toBeUndefined();
    expect(bypassRefusal({}, undefined)).toBeUndefined();
    expect(bypassRefusal({}, 0)).toContain('refused when running as root');
    expect(bypassRefusal({ VINAX_ALLOW_ROOT_BYPASS: '1' }, 0)).toBeUndefined();
  });

  it('accepts the new modes in settings and tells the model about read-only mode', () => {
    expect(settingsSchema.parse({ permissions: { defaultMode: 'readOnly' } })).toBeTruthy();
    expect(settingsSchema.parse({ permissions: { defaultMode: 'bypass' } })).toBeTruthy();
    expect(() => settingsSchema.parse({ sandbox: 'everything' })).toThrow();
    expect(resolveSettings({}).sandbox).toBe('off');
    expect(resolveSettings({ sandbox: 'workspace-write' }).sandbox).toBe('workspace-write');
    const env = { cwd: '/w', shell: 'bash', date: '2026-10-16', git: undefined };
    expect(buildSystemPrompt(env, 'readOnly')).toContain('Read-only mode is on');
    expect(buildSystemPrompt(env, 'default')).not.toContain('Read-only mode is on');
  });
});

describe('sandbox', () => {
  const id = (p: string) => p;

  it('writes a Seatbelt profile that only allows writes to the writable roots', () => {
    const write = seatbeltProfile('workspace-write', ['/work/app', '/tmp/x"y']);
    expect(write).toContain('(deny file-write*)');
    expect(write).toContain('(subpath "/work/app")');
    expect(write).toContain('(subpath "/tmp/x\\"y")');
    expect(write).not.toContain('(deny network*)');
    const ro = seatbeltProfile('read-only', ['/tmp']);
    expect(ro).toContain('(deny network*)');
  });

  it('works out the writable roots per mode', () => {
    const env = { TMPDIR: '/var/tmp-x', VINAX_HOME: '/home/me/.vinax' };
    const ww = writableRoots('workspace-write', {
      workspace: ['/work/app', '/work/lib'],
      env,
      realpath: id,
    });
    expect(ww).toEqual(
      expect.arrayContaining(['/work/app', '/work/lib', '/home/me/.vinax', '/var/tmp-x', '/tmp']),
    );
    const ro = writableRoots('read-only', { workspace: ['/work/app'], env, realpath: id });
    expect(ro).not.toContain('/work/app');
    expect(ro).not.toContain('/home/me/.vinax');
    expect(ro).toContain('/var/tmp-x');
  });

  it('builds bubblewrap arguments with the network cut in read-only mode', () => {
    const args = bwrapArgs('read-only', [os.tmpdir()]);
    expect(args.slice(0, 3)).toEqual(['--ro-bind', '/', '/']);
    expect(args).toContain('--unshare-net');
    expect(args.at(-1)).toBe('--');
    expect(bwrapArgs('workspace-write', [os.tmpdir()])).not.toContain('--unshare-net');
  });

  it('wraps commands per platform and is unavailable where it cannot run', () => {
    const workspace = () => ['/work/app'];
    expect(createSandbox('off', { workspace })).toEqual({ mode: 'off' });
    const mac = createSandbox('workspace-write', {
      workspace,
      platform: 'darwin',
      which: (p) => (p === 'sandbox-exec' ? '/usr/bin/sandbox-exec' : undefined),
      realpath: id,
      env: {},
    });
    expect('wrap' in mac && mac.kind).toBe('seatbelt');
    if (!('wrap' in mac)) throw new Error('expected a sandbox');
    const spec = mac.wrap({ file: '/bin/bash', args: ['-c', 'ls'] });
    expect(spec.file).toBe('/usr/bin/sandbox-exec');
    expect(spec.args[0]).toBe('-p');
    expect(spec.args.slice(2)).toEqual(['/bin/bash', '-c', 'ls']);
    expect(spec.args[1]).toContain('(subpath "/work/app")');

    const linux = createSandbox('read-only', {
      workspace,
      platform: 'linux',
      which: (p) => (p === 'bwrap' ? '/usr/bin/bwrap' : undefined),
      realpath: id,
      env: {},
    });
    if (!('wrap' in linux)) throw new Error('expected a sandbox');
    const l = linux.wrap({ file: '/bin/bash', args: ['-c', 'ls'] });
    expect(l.file).toBe('/usr/bin/bwrap');
    expect(l.args.slice(-3)).toEqual(['/bin/bash', '-c', 'ls']);
    expect(l.args).toContain('--unshare-net');

    const noBwrap = createSandbox('workspace-write', {
      workspace,
      platform: 'linux',
      which: () => undefined,
    });
    expect(sandboxRefusal(noBwrap)).toContain('bubblewrap (bwrap) is not installed');
    const windows = createSandbox('read-only', {
      workspace,
      platform: 'win32',
      which: () => undefined,
    });
    expect(sandboxRefusal(windows)).toContain('not supported on win32');
    expect(sandboxRefusal(createSandbox('off', { workspace }))).toBeUndefined();
  });

  it('runs Bash commands through the sandbox, and refuses them when it is unavailable', async () => {
    if (process.platform === 'win32') return;
    const dir = await tmp();
    const info = detectShell();
    const shell = new ShellSession(info, dir, process.env);
    shells.push(shell);
    const bash = createToolset({ shell: info, todos: new TodoStore() }).find(
      (t) => t.name === 'Bash',
    );
    const ctx: ToolContext = {
      cwd: dir,
      workspace: [dir],
      shell,
      reads: new ReadTracker(),
      signal: new AbortController().signal,
    };
    // a stand-in sandbox that runs the command through env, setting a marker variable
    shell.sandbox = {
      mode: 'workspace-write',
      kind: 'bwrap',
      wrap: (spec) => ({
        file: '/usr/bin/env',
        args: ['VX_SANDBOXED=yes', spec.file, ...spec.args],
      }),
    };
    const ran = await bash?.run({ command: 'echo "marker=$VX_SANDBOXED"' }, ctx);
    expect(ran?.content).toContain('marker=yes');

    shell.sandbox = { mode: 'read-only', unavailable: 'bwrap is missing.' };
    const refused = await bash?.run({ command: 'echo hi' }, ctx);
    expect(refused).toMatchObject({ ok: false, summary: 'Refused: sandbox unavailable' });
    expect(refused?.content).toContain('read-only sandbox is on but bwrap is missing.');
  });

  it.runIf(process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec'))(
    'blocks writes outside the workspace with the real macOS sandbox',
    async () => {
      const project = await tmp();
      const outside = await tmp();
      const shell = new ShellSession(detectShell(), project, process.env);
      shells.push(shell);
      shell.sandbox = createSandbox('workspace-write', {
        workspace: () => [project],
        tempDirs: [],
        env: { VINAX_HOME: project },
      });
      const signal = new AbortController().signal;
      const inside = await shell.run('echo ok > inside.txt && cat inside.txt', {
        timeoutMs: 20_000,
        signal,
      });
      expect(inside.output.trim()).toBe('ok');
      const blocked = await shell.run(`echo bad > ${JSON.stringify(path.join(outside, 'x.txt'))}`, {
        timeoutMs: 20_000,
        signal,
      });
      expect(blocked.exitCode).not.toBe(0);
      expect(existsSync(path.join(outside, 'x.txt'))).toBe(false);
    },
  );
});

describe('WebSearch', () => {
  const DDG_HTML = `
    <div class="result results_links results_links_deep web-result">
      <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fvitest.dev%2Fguide%2F&amp;rut=abc">Getting Started | <b>Vitest</b></a></h2>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fvitest.dev%2Fguide%2F">Vitest is a next generation testing framework &amp; more.</a>
    </div>
    <div class="result results_links result--ad">
      <a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=ads.example&amp;u3=x">Ad</a>
    </div>
    <div class="result">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Fvitest-dev%2Fvitest">vitest-dev/vitest</a>
      <a class="result__snippet">Next generation testing framework powered by Vite.</a>
    </div>
    <div class="result">
      <a class="result__a" href="https://www.npmjs.com/package/vitest">vitest - npm</a>
    </div>`;

  const ctx = (signal = new AbortController().signal): ToolContext => ({
    cwd: '/w',
    workspace: ['/w'],
    shell: new ShellSession(detectShell(), os.tmpdir(), process.env),
    reads: new ReadTracker(),
    signal,
  });

  it('parses DuckDuckGo results, unwrapping redirect links and skipping ads', () => {
    expect(unwrapDuckDuckGoUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.dev%2Fx&rut=1')).toBe(
      'https://a.dev/x',
    );
    expect(unwrapDuckDuckGoUrl('https://duckduckgo.com/y.js?ad=1')).toBeUndefined();
    expect(unwrapDuckDuckGoUrl('javascript:alert(1)')).toBeUndefined();
    expect(parseDuckDuckGoHtml(DDG_HTML)).toEqual([
      {
        title: 'Getting Started | Vitest',
        url: 'https://vitest.dev/guide/',
        snippet: 'Vitest is a next generation testing framework & more.',
      },
      {
        title: 'vitest-dev/vitest',
        url: 'https://github.com/vitest-dev/vitest',
        snippet: 'Next generation testing framework powered by Vite.',
      },
      { title: 'vitest - npm', url: 'https://www.npmjs.com/package/vitest', snippet: '' },
    ]);
  });

  it('searches DuckDuckGo without a key and filters by domain', async () => {
    const requests: { url: string; body: string }[] = [];
    const fakeFetch = ((url: string | URL, init?: RequestInit) => {
      requests.push({ url: String(url), body: typeof init?.body === 'string' ? init.body : '' });
      return Promise.resolve(new Response(DDG_HTML, { status: 200 }));
    }) as typeof fetch;
    const tool = createWebSearchTool({ env: {}, fetch: fakeFetch });
    expect(tool.kind).toBe('network');
    expect(tool.readOnly).toBe(true);
    const out = await tool.run(tool.input.parse({ query: 'vitest docs' }), ctx());
    expect(out.ok).toBe(true);
    expect(out.summary).toBe('3 results · DuckDuckGo');
    expect(out.content).toContain('1. Getting Started | Vitest\n   https://vitest.dev/guide/');
    expect(out.content).toContain('3. vitest - npm');
    expect(requests[0]?.url).toBe('https://html.duckduckgo.com/html/');
    expect(requests[0]?.body).toContain('q=vitest+docs');

    const blocked = await tool.run(
      tool.input.parse({ query: 'vitest', blocked_domains: ['github.com'], max_results: 1 }),
      ctx(),
    );
    expect(blocked.content).toContain('vitest.dev');
    expect(blocked.content).not.toContain('github.com/vitest-dev');
    expect(blocked.summary).toBe('1 result · DuckDuckGo');

    const allowed = await tool.run(
      tool.input.parse({ query: 'vitest', allowed_domains: ['github.com'] }),
      ctx(),
    );
    expect(allowed.content).toContain('github.com/vitest-dev/vitest');
    expect(allowed.content).not.toContain('vitest.dev/guide');
    // one allowed domain is also passed to DuckDuckGo as site:
    expect(requests.at(-1)?.body).toContain('site%3Agithub.com');
  });

  it('uses Brave or Tavily when their key is set', async () => {
    expect(pickSearchProvider({})).toBe('duckduckgo');
    expect(pickSearchProvider({ TAVILY_API_KEY: 't' })).toBe('tavily');
    expect(pickSearchProvider({ BRAVE_API_KEY: 'b', TAVILY_API_KEY: 't' })).toBe('brave');
    const seen: { url: string; headers: Headers }[] = [];
    const fakeFetch = ((url: string | URL, init?: RequestInit) => {
      seen.push({ url: String(url), headers: new Headers(init?.headers) });
      const body = String(url).includes('brave')
        ? {
            web: {
              results: [
                { title: 'B <strong>one</strong>', url: 'https://b.dev', description: 'brave hit' },
              ],
            },
          }
        : { results: [{ title: 'T one', url: 'https://t.dev', content: 'tavily  hit' }] };
      return Promise.resolve(Response.json(body));
    }) as typeof fetch;
    const brave = await webSearch('q', {
      env: { BRAVE_API_KEY: 'bk' },
      fetch: fakeFetch,
      signal: new AbortController().signal,
    });
    expect(brave).toEqual({
      provider: 'brave',
      results: [{ title: 'B one', url: 'https://b.dev', snippet: 'brave hit' }],
    });
    expect(seen[0]?.headers.get('x-subscription-token')).toBe('bk');
    const tavily = await webSearch('q', {
      env: { TAVILY_API_KEY: 'tk' },
      fetch: fakeFetch,
      signal: new AbortController().signal,
    });
    expect(tavily.results).toEqual([
      { title: 'T one', url: 'https://t.dev', snippet: 'tavily hit' },
    ]);
    expect(seen[1]?.headers.get('authorization')).toBe('Bearer tk');
  });

  it('reports failures to the model instead of throwing', async () => {
    const failing = createWebSearchTool({
      env: {},
      fetch: () => Promise.resolve(new Response('nope', { status: 503 })),
    });
    const out = await failing.run(failing.input.parse({ query: 'x y' }), ctx());
    expect(out).toMatchObject({ ok: false, summary: 'Search failed' });
    expect(out.content).toContain('DuckDuckGo answered HTTP 503');

    const limited = createWebSearchTool({
      env: {},
      fetch: () => Promise.resolve(new Response('<form id="challenge-form">anomaly</form>')),
    });
    const r = await limited.run(limited.input.parse({ query: 'x y' }), ctx());
    expect(r.content).toContain('rate-limiting');

    const empty = createWebSearchTool({
      env: {},
      fetch: () => Promise.resolve(new Response('<html></html>')),
    });
    expect((await empty.run(empty.input.parse({ query: 'zzz' }), ctx())).summary).toBe(
      'No results',
    );
  });

  it('stops when the turn is aborted', async () => {
    const hanging = createWebSearchTool({
      env: {},
      fetch: (_: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    });
    const ac = new AbortController();
    const running = hanging.run(hanging.input.parse({ query: 'slow' }), ctx(ac.signal));
    ac.abort();
    await expect(running).rejects.toThrow();
  });
});

describe('instruction files from other agents', () => {
  let root: string;
  let home: string;
  beforeEach(async () => {
    root = await tmp();
    home = await tmp();
    execFileSync('git', ['init', '-q'], { cwd: root });
  });

  it('reads CLAUDE.md, GEMINI.md and Copilot instructions, skipping duplicates', async () => {
    await fs.writeFile(path.join(root, 'VINAX.md'), 'VinaX rule.');
    await fs.writeFile(path.join(root, 'AGENTS.md'), 'Shared rule.');
    // a copy of AGENTS.md, as many repos keep for Claude Code
    await fs.writeFile(path.join(root, 'CLAUDE.md'), 'Shared rule.\n');
    await fs.writeFile(path.join(root, 'GEMINI.md'), 'Gemini rule.');
    await fs.mkdir(path.join(root, '.github'));
    await fs.writeFile(path.join(root, '.github', 'copilot-instructions.md'), 'Copilot rule.');
    const mem = ProjectMemory.load(root, { VINAX_HOME: home });
    expect(mem.files.map((f) => path.relative(root, f.path))).toEqual([
      'VINAX.md',
      'AGENTS.md',
      'GEMINI.md',
      path.join('.github', 'copilot-instructions.md'),
    ]);
    const text = mem.text();
    expect(text.indexOf('VinaX rule')).toBeLessThan(text.indexOf('Gemini rule'));
    expect(text.split('Shared rule.').length).toBe(2);
    // nested folders pick up CLAUDE.md too
    await fs.mkdir(path.join(root, 'pkg'));
    await fs.writeFile(path.join(root, 'pkg', 'CLAUDE.md'), 'Package rule.');
    expect(mem.discover(path.join(root, 'pkg', 'a.ts')).map((f) => f.content)).toEqual([
      'Package rule.',
    ]);
  });
});
