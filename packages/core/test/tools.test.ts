import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyEdit,
  applyEdits,
  createToolset,
  detectShell,
  interactiveCommandReason,
  ReadTracker,
  ShellSession,
  splitCwdMarker,
  TodoStore,
  toolSpec,
  type AnyTool,
  type ToolContext,
  type ToolOutput,
} from '../src/index.js';

let dir: string;
let ctx: ToolContext;
let tools: AnyTool[];
let todos: TodoStore;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vinax-tools-')));
  const info = detectShell();
  todos = new TodoStore();
  tools = createToolset({ shell: info, todos });
  ctx = {
    cwd: dir,
    workspace: [dir],
    shell: new ShellSession(info, dir, process.env),
    reads: new ReadTracker(),
    signal: new AbortController().signal,
  };
});
afterEach(async () => {
  ctx.shell.killAll();
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

async function call(name: string, input: unknown): Promise<ToolOutput> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  const parsed = tool.input.parse(input);
  return tool.run(parsed, ctx);
}

const write = (rel: string, text: string) =>
  fs
    .mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
    .then(() => fs.writeFile(path.join(dir, rel), text));

describe('applyEdit', () => {
  it('replaces a unique match and rejects ambiguous or missing ones', () => {
    expect(applyEdit('a b a', { old_string: 'b', new_string: 'B' })).toEqual({
      ok: true,
      content: 'a B a',
      replacements: 1,
    });
    const amb = applyEdit('a b a', { old_string: 'a', new_string: 'x' });
    expect(amb.ok).toBe(false);
    expect(!amb.ok && amb.error).toContain('appears 2 times');
    expect(
      applyEdit('a b a', { old_string: 'a', new_string: 'x', replace_all: true }),
    ).toMatchObject({ content: 'x b x', replacements: 2 });
    expect(applyEdit('abc', { old_string: 'zz', new_string: 'y' }).ok).toBe(false);
    expect(applyEdit('abc', { old_string: 'b', new_string: 'b' }).ok).toBe(false);
    expect(applyEdit('abc', { old_string: '', new_string: 'b' }).ok).toBe(false);
  });

  it('keeps CRLF files CRLF and does not interpret $ patterns', () => {
    expect(
      applyEdit('one\r\ntwo\r\n', { old_string: 'one\ntwo', new_string: 'uno\ndos' }),
    ).toMatchObject({ content: 'uno\r\ndos\r\n' });
    expect(applyEdit('price', { old_string: 'price', new_string: '$& $1' })).toMatchObject({
      content: '$& $1',
    });
  });

  it('applies multiple edits atomically', () => {
    expect(
      applyEdits('a b c', [
        { old_string: 'a', new_string: 'A' },
        { old_string: 'c', new_string: 'C' },
      ]),
    ).toMatchObject({ content: 'A b C' });
    const bad = applyEdits('a b c', [
      { old_string: 'a', new_string: 'A' },
      { old_string: 'zz', new_string: 'C' },
    ]);
    expect(!bad.ok && bad.error).toContain('Edit 2 of 2');
  });
});

describe('file tools', () => {
  it('Read numbers lines, pages with offset/limit and rejects binaries', async () => {
    await write('a.txt', Array.from({ length: 5 }, (_, i) => `line ${String(i + 1)}`).join('\n'));
    const all = await call('Read', { file_path: 'a.txt' });
    expect(all.content.split('\n')[0]).toBe('     1\tline 1');
    expect(all.summary).toBe('Read 5 lines');
    const part = await call('Read', { file_path: 'a.txt', offset: 2, limit: 2 });
    expect(part.content).toContain('     2\tline 2\n     3\tline 3');
    expect(part.content).toContain('Showing lines 2–3 of 5');
    await fs.writeFile(path.join(dir, 'bin'), Buffer.from([1, 0, 2]));
    await expect(call('Read', { file_path: 'bin' })).rejects.toThrow(/binary/);
    await expect(call('Read', { file_path: 'missing.txt' })).rejects.toThrow(/not found/);
  });

  it('Write creates files but refuses to overwrite unread or changed ones', async () => {
    const created = await call('Write', {
      file_path: 'src/new.ts',
      content: 'export const x = 1;\n',
    });
    expect(created).toMatchObject({ ok: true, summary: 'Created with 1 lines' });
    expect(created.display).toMatchObject({ kind: 'diff', created: true, added: 1 });
    await write('old.txt', 'old');
    expect((await call('Write', { file_path: 'old.txt', content: 'new' })).content).toMatch(
      /Read the file first/,
    );
    await call('Read', { file_path: 'old.txt' });
    await write('old.txt', 'changed behind our back');
    expect((await call('Write', { file_path: 'old.txt', content: 'new' })).content).toMatch(
      /changed on disk/,
    );
    await call('Read', { file_path: 'old.txt' });
    expect((await call('Write', { file_path: 'old.txt', content: 'new' })).ok).toBe(true);
  });

  it('Edit needs a fresh read and produces a diff', async () => {
    await write('m.ts', 'const a = 1;\nconst b = 2;\n');
    expect(
      (await call('Edit', { file_path: 'm.ts', old_string: 'b = 2', new_string: 'b = 3' })).ok,
    ).toBe(false);
    await call('Read', { file_path: 'm.ts' });
    const r = await call('Edit', { file_path: 'm.ts', old_string: 'b = 2', new_string: 'b = 3' });
    expect(r).toMatchObject({ ok: true, summary: 'Changed +1 −1 lines' });
    expect(await fs.readFile(path.join(dir, 'm.ts'), 'utf8')).toBe('const a = 1;\nconst b = 3;\n');
    const lines = r.display?.kind === 'diff' ? r.display.hunks[0]?.lines : [];
    expect(lines).toContainEqual({ kind: 'remove', text: 'const b = 2;', oldLine: 2 });
    expect(lines).toContainEqual({ kind: 'add', text: 'const b = 3;', newLine: 2 });
    // a second edit right after works: the tool updated its own read record
    expect(
      (await call('Edit', { file_path: 'm.ts', old_string: 'a = 1', new_string: 'a = 0' })).ok,
    ).toBe(true);
  });

  it('MultiEdit is all-or-nothing', async () => {
    await write('m.ts', 'x y z');
    await call('Read', { file_path: 'm.ts' });
    const bad = await call('MultiEdit', {
      file_path: 'm.ts',
      edits: [
        { old_string: 'x', new_string: 'X' },
        { old_string: 'q', new_string: 'Q' },
      ],
    });
    expect(bad.ok).toBe(false);
    expect(await fs.readFile(path.join(dir, 'm.ts'), 'utf8')).toBe('x y z');
    const good = await call('MultiEdit', {
      file_path: 'm.ts',
      edits: [
        { old_string: 'x', new_string: 'X' },
        { old_string: 'z', new_string: 'Z' },
      ],
    });
    expect(good.ok).toBe(true);
    expect(await fs.readFile(path.join(dir, 'm.ts'), 'utf8')).toBe('X y Z');
  });
});

describe('search tools', () => {
  beforeEach(async () => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    await write('.gitignore', 'dist/\n*.log\n');
    await write(
      'src/app.ts',
      'export function add(a: number, b: number) {\n  return a + b; // TODO tidy\n}\n',
    );
    await write('src/util.ts', 'export const TODO = 1;\n');
    await write('dist/app.js', 'TODO compiled\n');
    await write('debug.log', 'TODO log\n');
    await write('README.md', '# Demo\n');
  });

  it('Glob respects .gitignore', async () => {
    const r = await call('Glob', { pattern: '**/*' });
    const files = r.content.split('\n').sort();
    expect(files).toEqual(['.gitignore', 'README.md', 'src/app.ts', 'src/util.ts']);
  });

  it('Grep supports files, content and count modes', async () => {
    expect((await call('Grep', { pattern: 'TODO' })).content.split('\n')).toEqual([
      'src/app.ts',
      'src/util.ts',
    ]);
    const content = await call('Grep', {
      pattern: 'todo',
      output_mode: 'content',
      case_insensitive: true,
      glob: '*.ts',
    });
    expect(content.content).toContain('src/app.ts:2:  return a + b; // TODO tidy');
    const count = await call('Grep', { pattern: 'TODO', output_mode: 'count' });
    expect(count.content).toContain('src/util.ts:1');
    expect((await call('Grep', { pattern: 'nothing-here' })).summary).toBe('No matches');
  });

  it('LS lists a two-level tree without ignored entries', async () => {
    const r = await call('LS', {});
    expect(r.content).toContain('src/');
    expect(r.content).toContain('    app.ts');
    expect(r.content).not.toContain('dist');
    expect(r.content).not.toContain('debug.log');
  });
});

describe('Bash', () => {
  it('keeps the working directory between calls and reports exit codes', async () => {
    await fs.mkdir(path.join(dir, 'sub'));
    expect((await call('Bash', { command: 'cd sub && echo moved' })).content).toBe('moved');
    expect(ctx.shell.cwd).toBe(path.join(dir, 'sub'));
    // Git Bash prints its own /c/... form for `pwd`, so check the command's output only elsewhere
    if (process.platform !== 'win32') {
      const pwd = await call('Bash', { command: 'pwd' });
      expect(pwd.content.trim()).toBe(path.join(dir, 'sub'));
    }
    const failing = await call('Bash', { command: 'echo oops >&2; exit 3' });
    expect(failing.ok).toBe(false);
    expect(failing.content).toContain('oops');
    expect(failing.content).toContain('[exit code 3]');
    expect(failing.summary).toMatch(/^Exit 3 · 1 line · /);
  });

  it('times out, refuses interactive commands and runs background jobs', async () => {
    const slow = await call('Bash', { command: 'sleep 5', timeout: 300 });
    expect(slow.content).toContain('[timed out');
    expect((await call('Bash', { command: 'vim notes.txt' })).summary).toBe(
      'Refused: interactive command',
    );
    const started = await call('Bash', {
      command: 'echo bg-start; sleep 0.2; echo bg-end',
      run_in_background: true,
    });
    const id = /job_\d+/.exec(started.content)?.[0] ?? '';
    await new Promise((r) => setTimeout(r, 600));
    const out = await call('BashOutput', { id });
    expect(out.content).toContain('bg-start');
    expect(out.content).toContain('bg-end');
    expect(out.content).toContain('finished with exit code 0');
  });

  it('detects interactive programs', () => {
    expect(interactiveCommandReason('less README.md')).toMatch(/keyboard input/);
    expect(interactiveCommandReason('npm test && python')).toMatch(/interactive session/);
    expect(interactiveCommandReason('python -c "print(1)"')).toBeUndefined();
    expect(interactiveCommandReason('node --test')).toBeUndefined();
    expect(interactiveCommandReason('python -m pytest -q')).toBeUndefined();
    expect(interactiveCommandReason('node -i')).toMatch(/interactive session/);
    expect(interactiveCommandReason('git rebase -i HEAD~3')).toMatch(/Interactive git/);
    expect(interactiveCommandReason('ssh host uptime')).toBeUndefined();
    expect(interactiveCommandReason('ssh host')).toMatch(/ssh/);
  });

  it('strips the cwd marker from output', () => {
    expect(splitCwdMarker('hello\n__VX_CWD__/tmp/x\n')).toEqual({ output: 'hello', cwd: '/tmp/x' });
    expect(splitCwdMarker('no marker')).toEqual({ output: 'no marker', cwd: undefined });
  });
});

describe('TodoWrite and tool specs', () => {
  it('stores the task list', async () => {
    const r = await call('TodoWrite', {
      todos: [
        { content: 'Run tests', status: 'completed' },
        { content: 'Fix bug', status: 'in_progress' },
      ],
    });
    expect(r.summary).toBe('1/2 done');
    expect(todos.todos).toHaveLength(2);
  });

  it('produces compact JSON schemas for native tool calling', () => {
    const read = toolSpec(tools.find((t) => t.name === 'Read') as AnyTool);
    expect(read.parameters).toEqual({
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          minLength: 1,
          description: 'Path to the file: absolute, or relative to the project root',
        },
        offset: { type: 'integer', minimum: 1, description: '1-based line number to start from' },
        limit: {
          type: 'integer',
          exclusiveMinimum: 0,
          description: 'Maximum number of lines to return',
        },
      },
      required: ['file_path'],
    });
    expect(tools.map((t) => t.name)).toEqual([
      'Read',
      'Glob',
      'Grep',
      'LS',
      'Edit',
      'MultiEdit',
      'Write',
      'Bash',
      'BashOutput',
      'KillBash',
      'TodoWrite',
      'ExitPlanMode',
    ]);
  });
});
