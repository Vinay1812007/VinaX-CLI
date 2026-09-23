import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startMockServer, type MockServer } from '@vinax/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applySummary,
  attachMentions,
  CheckpointStore,
  conversationMarkdown,
  createAgentSetup,
  createRuntime,
  elideToolOutputs,
  expandCommand,
  expandImports,
  FileIndex,
  fuzzyScore,
  loadCustomCommands,
  parseFrontmatter,
  ProjectMemory,
  ReadTracker,
  runDoctor,
  SessionStore,
  splitArgs,
  UsageTracker,
  type ChatMessage,
} from '../src/index.js';

let root: string;
let cwd: string;
let home: string;
const servers: MockServer[] = [];

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vinax-wf-')));
  cwd = path.join(root, 'project');
  home = path.join(root, 'home');
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(home, { recursive: true });
});
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  await fs.rm(root, { recursive: true, force: true });
});

const write = async (p: string, text: string) => {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, text);
};

describe('SessionStore', () => {
  it('records, lists and replays a session including rewinds, resets and checkpoints', () => {
    const store = new SessionStore(path.join(home, 'p'), cwd);
    const w = store.create(new Date('2026-09-23T10:00:00Z'));
    const msg = (content: string): ChatMessage => ({ role: 'user', content });
    w.record({ type: 'turn', turn: 1, messageIndex: 0, prompt: 'first' });
    w.record({ type: 'message', message: msg('first') });
    w.record({ type: 'message', message: { role: 'assistant', content: 'ok' } });
    w.record({ type: 'checkpoint', turn: 1, file: '/x/a.ts', blob: w.storeBlob('old a') });
    w.record({ type: 'checkpoint', turn: 1, file: '/x/new.ts', blob: null });
    w.record({ type: 'turn', turn: 2, messageIndex: 2, prompt: 'second' });
    w.record({ type: 'message', message: msg('second') });
    w.record({ type: 'truncate', messageCount: 2, turnsKept: 1 });
    w.record({ type: 'title', title: 'Fix the tests' });
    w.record({ type: 'view', data: { kind: 'user', text: 'first' } });

    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: w.id,
      title: 'Fix the tests',
      firstPrompt: 'first',
      turns: 2,
    });
    const loaded = store.load(w.id);
    expect(loaded.messages.map((m) => m.content)).toEqual(['first', 'ok']);
    expect(loaded.marks.map((m) => m.prompt)).toEqual(['first']);
    expect(loaded.checkpoints.get(1)).toEqual(
      new Map([
        ['/x/a.ts', 'old a'],
        ['/x/new.ts', null],
      ]),
    );
    expect(loaded.views).toEqual([{ kind: 'user', text: 'first' }]);

    const w2 = store.open(w.id);
    w2.record({ type: 'reset', messages: [msg('summary')] });
    expect(store.load(w.id)).toMatchObject({ messages: [{ content: 'summary' }], marks: [] });
    expect(store.latest()?.id).toBe(w.id);
  });

  it('persists checkpoints through the CheckpointStore', async () => {
    const store = new SessionStore(path.join(home, 'p'), cwd);
    const w = store.create();
    const file = path.join(cwd, 'a.txt');
    await write(file, 'v1');
    const cp = new CheckpointStore(w);
    cp.beginTurn(1);
    await cp.capture([file]);
    await write(file, 'v2');
    const restored = new CheckpointStore();
    restored.load(store.load(w.id).checkpoints);
    await restored.restoreTo(1);
    expect(await fs.readFile(file, 'utf8')).toBe('v1');
  });
});

describe('UsageTracker', () => {
  it('accumulates requests and tokens per provider and model across flushes', () => {
    const u = new UsageTracker({ VINAX_HOME: home }, () => '2026-09-23');
    u.recordRequest({ provider: 'groq', model: 'a' });
    u.recordTokens({ provider: 'groq', model: 'a' }, { promptTokens: 100, completionTokens: 20 });
    u.flush();
    u.recordRequest({ provider: 'groq', model: 'b' });
    const day = u.snapshot();
    expect(day.providers.groq).toMatchObject({
      requests: 2,
      promptTokens: 100,
      completionTokens: 20,
    });
    expect(day.providers.groq?.models.b?.requests).toBe(1);
    expect(
      new UsageTracker({ VINAX_HOME: home }, () => '2026-09-23').read().providers.groq?.requests,
    ).toBe(2);
  });
});

describe('ProjectMemory', () => {
  it('loads user and ancestor files, expands imports and finds nested files on demand', async () => {
    execFileSync('git', ['init', '-q'], { cwd: root });
    await write(path.join(home, 'VINAX.md'), 'Personal: be terse.');
    await write(path.join(root, 'AGENTS.md'), 'Repo rule: use pnpm.');
    await write(
      path.join(cwd, 'VINAX.md'),
      'Project rule. See @docs/style.md and `@not/imported.md`.',
    );
    await write(path.join(cwd, 'docs', 'style.md'), 'Two-space indent. @deeper.md');
    await write(path.join(cwd, 'docs', 'deeper.md'), 'Deep import works.');
    await write(path.join(cwd, 'pkg', 'VINAX.md'), 'Package-specific rule.');
    const mem = ProjectMemory.load(cwd, { VINAX_HOME: home });
    const text = mem.text();
    expect(text).toContain('Personal: be terse.');
    expect(text.indexOf('Repo rule')).toBeLessThan(text.indexOf('Project rule'));
    expect(text).toContain('Two-space indent. Deep import works.');
    expect(text).toContain('`@not/imported.md`');
    expect(text).not.toContain('Package-specific');
    const found = mem.discover(path.join(cwd, 'pkg', 'src', 'x.ts'));
    expect(found.map((f) => f.content)).toEqual(['Package-specific rule.']);
    expect(mem.discover(path.join(cwd, 'pkg', 'y.ts'))).toEqual([]);
  });

  it('stops imports at depth four and appends notes', async () => {
    for (let i = 0; i < 6; i++)
      await write(path.join(cwd, `f${String(i)}.md`), `L${String(i)} @f${String(i + 1)}.md`);
    expect(expandImports('@f0.md', cwd)).toBe('L0 L1 L2 L3 @f4.md');
    const mem = ProjectMemory.load(cwd, { VINAX_HOME: home });
    const file = await mem.addNote('project', 'Always run the linter');
    expect(await fs.readFile(file, 'utf8')).toBe(
      '# Project instructions\n\n- Always run the linter\n',
    );
    expect(mem.text()).toContain('Always run the linter');
  });
});

describe('compaction', () => {
  it('elides old long tool outputs but keeps recent ones', () => {
    const msgs: ChatMessage[] = Array.from({ length: 9 }, (_, i) => ({
      role: 'tool',
      toolCallId: String(i),
      name: 'Read',
      content: 'x'.repeat(1000),
    }));
    const { messages, elided } = elideToolOutputs(msgs);
    expect(elided).toBe(3);
    expect(messages[0]?.content).toMatch(/^\[output of Read removed/);
    expect(messages[8]?.content).toHaveLength(1000);
  });

  it('folds the summary into the current turn', () => {
    expect(applySummary('S', [{ role: 'user', content: 'now' }])[0]?.content).toMatch(
      /<conversation-summary>[\s\S]*S[\s\S]*<\/conversation-summary>\n\nnow$/,
    );
    expect(applySummary('S', [])).toHaveLength(1);
  });

  it('summarizes with the small model when the conversation outgrows its budget', async () => {
    const groq = await startMockServer({
      script: {
        main: [{ text: 'first answer '.repeat(300) }, { text: 'after compaction' }],
        small: [{ text: '## Goal\nKeep going.' }],
      },
    });
    servers.push(groq);
    await write(
      path.join(home, 'settings.json'),
      JSON.stringify({
        model: 'groq:main',
        smallModel: 'groq:small',
        fallbackChain: [],
        providers: { groq: { baseUrl: groq.url }, openrouter: { enabled: false } },
        context: { maxTokens: 4000 },
        router: { maxRetries: 0 },
      }),
    );
    const env = {
      VINAX_HOME: home,
      VINAX_SECRETS_BACKEND: 'file',
      GROQ_API_KEY: 'gsk_test000000000',
      PATH: process.env.PATH,
    };
    const runtime = await createRuntime({ cwd, env });
    const setup = await createAgentSetup(runtime);
    const host = {
      mode: () => 'default' as const,
      askPermission: () => Promise.resolve({ kind: 'allow' as const }),
    };
    const events: string[] = [];
    await setup.agent.run('one', {
      signal: new AbortController().signal,
      host,
      onEvent: () => undefined,
    });
    await setup.agent.run('two', {
      signal: new AbortController().signal,
      host,
      onEvent: (e) => events.push(e.type === 'compact' ? `compact:${e.kind}` : e.type),
    });
    expect(events[0]).toBe('compact:summary');
    const bodies = groq.requests
      .filter((r) => r.path === '/v1/chat/completions')
      .map((r) => r.body as { model: string; messages: { content: string }[] });
    expect(bodies.map((b) => b.model)).toEqual(['main', 'small', 'main']);
    const last = bodies.at(-1);
    expect(last?.messages[1]?.content).toContain('## Goal\nKeep going.');
    expect(last?.messages[1]?.content).toMatch(/two$/);
    expect(setup.agent.messages).toHaveLength(2);
  });
});

describe('custom commands', () => {
  it('parses frontmatter lists and inline values', () => {
    const { data, body } = parseFrontmatter(
      '---\ndescription: "Review a PR"\nallowed-tools:\n  - Bash(git diff:*)\n  - Read\nmodel: groq:x # comment\n---\nBody $1',
    );
    expect(data).toEqual({
      description: 'Review a PR',
      'allowed-tools': ['Bash(git diff:*)', 'Read'],
      model: 'groq:x',
    });
    expect(body).toBe('Body $1');
    expect(splitArgs(`a "b c" 'd e' f`)).toEqual(['a', 'b c', 'd e', 'f']);
  });

  it('loads project and user commands with namespaces and expands them', async () => {
    await write(path.join(home, 'commands', 'hello.md'), 'Say hello to $ARGUMENTS.');
    await write(
      path.join(cwd, '.vinax', 'commands', 'hello.md'),
      '---\ndescription: Project hello\n---\nProject hello to $1 and $2.',
    );
    await write(
      path.join(cwd, '.vinax', 'commands', 'git', 'review.md'),
      '---\nallowed-tools: Bash(git status:*), Read\nargument-hint: <focus>\n---\nStatus:\n!`git status --short`\nNot allowed: !`rm -rf x`\nFocus: $ARGUMENTS\nSee @notes.md',
    );
    await write(path.join(cwd, 'notes.md'), 'NOTES CONTENT');
    const { commands, errors } = await loadCustomCommands(cwd, { VINAX_HOME: home });
    expect(errors).toEqual([]);
    expect(commands.map((c) => [c.name, c.scope])).toEqual([
      ['git:review', 'project'],
      ['hello', 'project'],
    ]);
    const hello = commands.find((c) => c.name === 'hello');
    if (!hello) throw new Error('missing');
    const plain = await expandCommand(hello, '"Ada Lovelace" Bob', {
      cwd,
      workspace: [cwd],
      runShell: () => Promise.resolve(''),
    });
    expect(plain.prompt).toBe('Project hello to Ada Lovelace and Bob.');
    const review = commands.find((c) => c.name === 'git:review');
    if (!review) throw new Error('missing');
    const ran: string[] = [];
    const out = await expandCommand(review, 'security', {
      cwd,
      workspace: [cwd],
      runShell: (c) => {
        ran.push(c);
        return Promise.resolve(' M src/a.ts\n');
      },
    });
    expect(ran).toEqual(['git status --short']);
    expect(out.prompt).toContain('Status:\nM src/a.ts');
    expect(out.prompt).toContain('[not run: add "allowed-tools: Bash(rm:*)"');
    expect(out.prompt).toContain('Focus: security');
    expect(out.prompt).toContain('NOTES CONTENT');
    expect(out.warnings).toHaveLength(1);
    expect(review.argumentHint).toBe('<focus>');
  });
});

describe('files', () => {
  it('ranks fuzzy matches by file name and word starts', () => {
    expect(fuzzyScore('zz', 'src/app.ts')).toBeUndefined();
    const ranked = ['docs/app-notes.md', 'src/app.ts', 'src/utils/mapper.ts'].sort(
      (a, b) => (fuzzyScore('app', b) ?? -1) - (fuzzyScore('app', a) ?? -1),
    );
    expect(ranked[0]).toBe('src/app.ts');
  });

  it('indexes project files and attaches @mentions', async () => {
    execFileSync('git', ['init', '-q'], { cwd });
    await write(path.join(cwd, '.gitignore'), 'dist/\n');
    await write(path.join(cwd, 'src', 'app.ts'), 'export const x = 1;\n');
    await write(path.join(cwd, 'dist', 'app.js'), 'built');
    const index = new FileIndex(cwd);
    expect(await index.search('app')).toEqual(['src/app.ts']);
    expect(await index.list()).toContain('src/');
    const reads = new ReadTracker();
    const r = await attachMentions('look at @src/app.ts and @src, not @missing.ts', {
      cwd,
      workspace: [cwd],
      reads,
    });
    expect(r.attached).toEqual(['src/app.ts', 'src/']);
    expect(r.prompt).toContain('<file path="src/app.ts">\n     1\texport const x = 1;');
    expect(r.prompt).toContain('<folder path="src">\napp.ts');
    expect(await reads.checkFresh(path.join(cwd, 'src', 'app.ts'))).toBeUndefined();
  });
});

describe('doctor and export', () => {
  it('reports installation checks', async () => {
    const checks = await runDoctor({
      cwd,
      env: { VINAX_HOME: home, VINAX_SECRETS_BACKEND: 'file', PATH: process.env.PATH },
      version: '1.2.3',
      terminal: { isTTY: false, columns: undefined },
    });
    const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
    expect(byName['Node.js']?.status).toBe('ok');
    expect(byName.VinaX?.detail).toBe('v1.2.3');
    expect(byName['API keys']?.status).toBe('fail');
    expect(byName['Search (Grep)']?.detail).toMatch(/ripgrep/);
  });

  it('exports the conversation as Markdown', () => {
    const md = conversationMarkdown(
      [
        { role: 'user', content: 'fix it' },
        {
          role: 'assistant',
          content: 'Reading.',
          toolCalls: [{ id: '1', name: 'Read', arguments: '{"file_path":"a"}' }],
        },
        { role: 'tool', toolCallId: '1', name: 'Read', content: '1\tx' },
        { role: 'assistant', content: 'Done.' },
      ],
      { title: 'Fix', cwd: '/p', date: new Date('2026-09-23T10:00:00Z') },
    );
    expect(md).toContain('# Fix');
    expect(md).toContain('## You\n\nfix it');
    expect(md).toContain('> **Read** `{"file_path":"a"}`');
    expect(md).toContain('<details><summary>Read result</summary>');
  });
});
