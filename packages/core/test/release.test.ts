import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

let dir: string | undefined;
afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});
it('automatically versions code changes, skips docs-only changes and preserves an untagged version on retry', async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vinax-release-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  await fs.mkdir(path.join(dir, 'packages/cli'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'packages/cli/package.json'),
    JSON.stringify({ version: '1.0.0' }),
  );
  await fs.writeFile(path.join(dir, 'packages/cli/CHANGELOG.md'), '# CLI\n\n## 1.0.0\n');
  git('add', '.');
  git('commit', '-qm', 'initial');
  git('tag', 'v1.0.0');
  await fs.writeFile(path.join(dir, 'README.md'), 'docs');
  git('add', '.');
  git('commit', '-qm', 'docs');
  const run = () =>
    execFileSync(
      process.execPath,
      [fileURLToPath(new URL('../../../scripts/prepare-release.mjs', import.meta.url))],
      { cwd: dir, encoding: 'utf8' },
    );
  expect(run()).toContain('No code changes');
  await fs.writeFile(path.join(dir, 'packages/cli/code.ts'), 'export const fixed = true;');
  git('add', '.');
  git('commit', '-qm', 'fix model picker');
  expect(run()).toContain('Release v1.0.1');
  expect(run()).toContain('Release v1.0.1');
  expect(await fs.readFile(path.join(dir, 'packages/cli/CHANGELOG.md'), 'utf8')).toContain(
    '- fix model picker',
  );
});
