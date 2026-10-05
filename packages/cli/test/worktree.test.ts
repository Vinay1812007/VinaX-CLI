import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const ioFor = (hh: Harness) => ({
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  env: hh.env,
  cwd: hh.cwd,
});

async function repoHarness(script: Parameters<typeof createHarness>[0]) {
  h = await createHarness(script);
  git(h.cwd, 'init', '-q', '-b', 'main');
  git(h.cwd, 'config', 'user.email', 'test@example.com');
  git(h.cwd, 'config', 'user.name', 'Test');
  git(h.cwd, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(h.cwd, 'a.txt'), 'old\n');
  git(h.cwd, 'add', '-A');
  git(h.cwd, 'commit', '-q', '-m', 'init');
  return h;
}

describe('vinax --worktree', () => {
  it('runs a task in a worktree, then reviews, applies and removes it', async () => {
    const hh = await repoHarness({
      groq: {
        script: {
          'main-model': [
            { toolCalls: [{ name: 'Read', arguments: '{"file_path":"a.txt"}' }] },
            {
              toolCalls: [{ name: 'Write', arguments: '{"file_path":"a.txt","content":"new\\n"}' }],
            },
            { text: 'Rewrote a.txt.' },
          ],
        },
      },
    });
    const run = await hh.run([
      '-p',
      'rewrite a.txt',
      '--worktree',
      'job',
      '--permission-mode',
      'acceptEdits',
    ]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('Rewrote a.txt.');
    expect(run.stderr).toContain('Created worktree job (branch vinax/job)');
    expect(run.stderr).toContain('it is not a sandbox');
    expect(run.stderr).toContain('vinax worktree apply job');
    // the checkout is untouched
    expect(await fs.readFile(path.join(hh.cwd, 'a.txt'), 'utf8')).toBe('old\n');

    const list = await hh.run(['worktree', 'list']);
    expect(list.stdout).toContain('job  vinax/job  1 file changed');
    const stat = await hh.run(['worktree', 'diff', 'job', '--stat']);
    expect(stat.stdout).toContain('a.txt  +1 −1');
    const diff = await hh.run(['worktree', 'diff', 'job']);
    expect(diff.stdout).toContain('-old\n+new');

    const refused = await hh.run(['worktree', 'remove', 'job']);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('has changes you have not applied');

    const applied = await hh.run(['worktree', 'apply', 'job']);
    expect(applied.code).toBe(0);
    expect(applied.stdout).toContain('Applied 1 file from job to your checkout');
    expect(await fs.readFile(path.join(hh.cwd, 'a.txt'), 'utf8')).toBe('new\n');

    const removed = await hh.run(['worktree', 'remove', 'job']);
    expect(removed.stdout).toContain('Removed worktree job.');
    expect((await hh.run(['worktree', 'list'])).stdout).toContain('No VinaX worktrees');
  });

  it('starts in the same subfolder of the worktree, even through a symlinked temp path', async () => {
    const hh = await repoHarness({});
    const sub = path.join(hh.cwd, 'pkg', 'inner');
    await fs.mkdir(sub, { recursive: true });
    const { enterWorktree } = await import('../src/worktree-command.js');
    // hh.cwd is under os.tmpdir(), a symlink (/var → /private/var) on macOS
    const wt = await enterWorktree({ ...ioFor(hh), cwd: sub }, 'sub');
    expect(wt.cwd).toBe(path.join(wt.info.path, 'pkg', 'inner'));
    expect(wt.cwd.startsWith(wt.info.path)).toBe(true);
  });

  it('explains when the folder is not a git repository', async () => {
    h = await createHarness();
    const r = await h.run(['-p', 'hi', '--worktree']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Worktrees need a git repository');
    const l = await h.run(['worktree', 'list']);
    expect(l.code).toBe(1);
  });
});
