import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSystemPrompt, gitSection, parseGitStatus, readGitInfo } from '../src/index.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe('git status parsing', () => {
  it('reads branch, upstream and staged/unstaged/untracked files', () => {
    const parsed = parseGitStatus(
      [
        '## main...origin/main [ahead 2, behind 1]',
        'M  src/staged.ts',
        ' M src/changed.ts',
        'MM src/both.ts',
        '?? notes.md',
      ].join('\n'),
    );
    expect(parsed.branch).toBe('main');
    expect(parsed.upstream).toEqual({ name: 'origin/main', ahead: 2, behind: 1 });
    expect(parsed.staged).toEqual(['src/staged.ts', 'src/both.ts']);
    expect(parsed.unstaged).toEqual(['src/changed.ts', 'src/both.ts']);
    expect(parsed.untracked).toEqual(['notes.md']);
    expect(parsed.counts).toEqual({ staged: 2, unstaged: 2, untracked: 1 });
  });

  it('handles a new repository without an upstream, and caps long lists', () => {
    const rows = Array.from({ length: 30 }, (_, i) => `?? file${String(i)}.txt`);
    const parsed = parseGitStatus(['## No commits yet on trunk', ...rows].join('\n'));
    expect(parsed.branch).toBe('trunk');
    expect(parsed.upstream).toBeUndefined();
    expect(parsed.untracked).toHaveLength(12);
    expect(parsed.counts.untracked).toBe(30);
  });

  it('renders a compact section for the system prompt', () => {
    const text = gitSection({
      branch: 'feat/x',
      status: ' M a.ts',
      upstream: { name: 'origin/feat/x', ahead: 0, behind: 0 },
      staged: [],
      unstaged: ['a.ts'],
      untracked: [],
      counts: { staged: 0, unstaged: 1, untracked: 0 },
      recentCommits: ['abc1234 Add thing'],
    });
    expect(text).toContain('- Git branch: feat/x');
    expect(text).toContain('- Upstream: origin/feat/x (up to date)');
    expect(text).toContain('- Changes: 0 staged, 1 unstaged, 0 untracked');
    expect(text).toContain('    abc1234 Add thing');
    expect(gitSection(undefined)).toBe('- Git: not a git repository');
  });
});

describe('readGitInfo', () => {
  it('reads a real repository and feeds the system prompt', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vinax-git-'));
    dirs.push(dir);
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: dir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 't',
          GIT_AUTHOR_EMAIL: 't@example.com',
          GIT_COMMITTER_NAME: 't',
          GIT_COMMITTER_EMAIL: 't@example.com',
        },
      });
    git('init', '-q', '-b', 'main');
    await fs.writeFile(path.join(dir, 'a.txt'), 'one\n');
    git('add', 'a.txt');
    git('commit', '-q', '-m', 'First commit');
    await fs.writeFile(path.join(dir, 'a.txt'), 'two\n');
    await fs.writeFile(path.join(dir, 'b.txt'), 'new\n');

    const info = await readGitInfo(dir);
    expect(info?.branch).toBe('main');
    expect(info?.unstaged).toEqual(['a.txt']);
    expect(info?.untracked).toEqual(['b.txt']);
    expect(info?.recentCommits).toHaveLength(1);
    expect(info?.recentCommits[0]).toMatch(/^[0-9a-f]{7,} First commit$/);

    const prompt = buildSystemPrompt(
      { cwd: dir, shell: 'bash', date: '2026-01-01', git: info },
      'default',
    );
    expect(prompt).toContain('- Changes: 0 staged, 1 unstaged, 1 untracked');
    expect(prompt).toContain('# Git');
    expect(await readGitInfo(os.tmpdir())).toBeUndefined();
  });
});
