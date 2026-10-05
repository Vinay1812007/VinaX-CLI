import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findRepoRoot, WorktreeError, WorktreeManager } from '../src/index.js';

let root: string;
let repo: string;
let env: Record<string, string>;
const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vinax-wt-test-')));
  repo = path.join(root, 'repo');
  env = { VINAX_HOME: path.join(root, 'home') };
  await fs.mkdir(repo, { recursive: true });
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'user.email', 'test@example.com');
  sh(repo, 'config', 'user.name', 'Test');
  sh(repo, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n');
  await fs.writeFile(path.join(repo, 'b.txt'), 'bee\n');
  await fs.writeFile(path.join(repo, '.gitignore'), 'ignored/\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'init');
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const read = (...p: string[]) => fs.readFile(path.join(...p), 'utf8');

describe('worktrees', () => {
  it('creates an isolated worktree outside the repository on its own branch', async () => {
    expect(await findRepoRoot(path.join(repo))).toBe(repo);
    expect(await findRepoRoot(root)).toBeUndefined();
    const m = new WorktreeManager(repo, env);
    const wt = await m.create('fix-1');
    expect(wt.branch).toBe('vinax/fix-1');
    expect(wt.path.startsWith(repo)).toBe(false);
    expect(await read(wt.path, 'a.txt')).toBe('one\ntwo\nthree\n');
    expect(sh(repo, 'branch', '--list', 'vinax/fix-1')).toContain('vinax/fix-1');
    await expect(m.create('fix-1')).rejects.toThrow(/already exists/);
    await expect(m.create('Bad Name')).rejects.toBeInstanceOf(WorktreeError);
    expect((await m.list()).map((w) => w.name)).toEqual(['fix-1']);
    expect((await m.open('fix-1')).created).toBe(false);
  });

  it('reviews commits, uncommitted edits and new files without touching either checkout', async () => {
    const m = new WorktreeManager(repo, env);
    const wt = await m.create('t');
    await fs.writeFile(path.join(wt.path, 'a.txt'), 'one\nTWO\nthree\n');
    sh(wt.path, 'commit', '-q', '-am', 'edit a');
    await fs.writeFile(path.join(wt.path, 'b.txt'), 'bee\nbuzz\n');
    await fs.writeFile(path.join(wt.path, 'new.txt'), 'fresh\n');
    await fs.mkdir(path.join(wt.path, 'ignored'));
    await fs.writeFile(path.join(wt.path, 'ignored', 'x.log'), 'noise\n');
    const before = sh(wt.path, 'status', '--porcelain');

    const c = await m.changes('t');
    expect(c.files).toEqual([
      { path: 'a.txt', added: 1, removed: 1, binary: false },
      { path: 'b.txt', added: 1, removed: 0, binary: false },
      { path: 'new.txt', added: 1, removed: 0, binary: false },
    ]);
    expect(c.patch).toContain('+fresh');
    // the worktree's own index and the main checkout are unchanged
    expect(sh(wt.path, 'status', '--porcelain')).toBe(before);
    expect(await read(repo, 'a.txt')).toBe('one\ntwo\nthree\n');
  });

  it('applies to a dirty checkout when nothing conflicts, keeping the other edits', async () => {
    const m = new WorktreeManager(repo, env);
    const wt = await m.create('t');
    await fs.writeFile(path.join(wt.path, 'a.txt'), 'one\nTWO\nthree\n');
    await fs.writeFile(path.join(wt.path, 'new.txt'), 'fresh\n');
    await fs.writeFile(path.join(repo, 'b.txt'), 'bee (mine)\n'); // the user's own work
    const r = await m.apply('t');
    expect(r.status).toBe('applied');
    if (r.status !== 'applied') return;
    expect(r.files.sort()).toEqual(['a.txt', 'new.txt']);
    expect(r.dirtyElsewhere).toEqual(['b.txt']);
    expect(await read(repo, 'a.txt')).toBe('one\nTWO\nthree\n');
    expect(await read(repo, 'new.txt')).toBe('fresh\n');
    expect(await read(repo, 'b.txt')).toBe('bee (mine)\n');
    // applied, so removing loses nothing
    expect(await m.remove('t')).toEqual({ status: 'removed', discarded: 0 });
    await expect(fs.stat(wt.path)).rejects.toThrow(/ENOENT/);
    expect(sh(repo, 'branch', '--list', 'vinax/t')).toBe('');
  });

  it('refuses to apply over conflicting edits and changes nothing', async () => {
    const m = new WorktreeManager(repo, env);
    const wt = await m.create('t');
    await fs.writeFile(path.join(wt.path, 'a.txt'), 'one\nTWO\nthree\n');
    await fs.writeFile(path.join(wt.path, 'new.txt'), 'fresh\n');
    await fs.writeFile(path.join(repo, 'a.txt'), 'one\n2\nthree\n');
    const r = await m.apply('t');
    expect(r.status).toBe('conflict');
    if (r.status !== 'conflict') return;
    expect(r.detail).toContain('a.txt');
    expect(await read(r.patchFile)).toContain('+TWO');
    expect(await read(repo, 'a.txt')).toBe('one\n2\nthree\n');
    await expect(fs.stat(path.join(repo, 'new.txt'))).rejects.toThrow(/ENOENT/);
  });

  it('will not remove a worktree with unapplied changes unless forced', async () => {
    const m = new WorktreeManager(repo, env);
    const wt = await m.create('t');
    await fs.writeFile(path.join(wt.path, 'a.txt'), 'changed\n');
    const refused = await m.remove('t');
    expect(refused).toEqual({
      status: 'unapplied',
      files: [{ path: 'a.txt', added: 1, removed: 3, binary: false }],
    });
    expect(await read(wt.path, 'a.txt')).toBe('changed\n');
    expect(await m.remove('t', { force: true })).toEqual({ status: 'removed', discarded: 1 });
    expect(await m.list()).toEqual([]);
  });

  it('reports nothing to apply for an untouched worktree', async () => {
    const m = new WorktreeManager(repo, env);
    await m.create('t');
    expect(await m.apply('t')).toEqual({ status: 'nothing' });
    expect(await m.remove('t')).toEqual({ status: 'removed', discarded: 0 });
  });
});
