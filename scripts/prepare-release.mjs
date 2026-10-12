import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const file = 'packages/cli/package.json';
const pkg = JSON.parse(readFileSync(file, 'utf8'));
const tag = `v${pkg.version}`;
const tagged = git('tag', '--list', tag) === tag;
let release = true;
if (tagged) {
  const changed = git(
    'diff',
    '--name-only',
    tag,
    'HEAD',
    '--',
    'packages',
    'apps',
    'scripts',
    '.github/workflows',
    'package.json',
    'pnpm-lock.yaml',
    'install.sh',
    'install.ps1',
  );
  release = changed !== '';
  if (release) {
    if (!/^\d+\.\d+\.\d+$/.test(pkg.version))
      throw new Error('Automatic releases require a stable semantic version');
    const [major, minor, patch] = pkg.version.split('.').map(Number);
    pkg.version = `${major}.${minor}.${patch + 1}`;
    writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
    const changes = git('log', '--format=- %s', `${tag}..HEAD`);
    const logFile = 'packages/cli/CHANGELOG.md';
    const log = readFileSync(logFile, 'utf8');
    const headingEnd = log.indexOf('\n');
    writeFileSync(
      logFile,
      `${log.slice(0, headingEnd + 1)}\n## ${pkg.version}\n\n${changes}\n${log.slice(headingEnd + 1)}`,
    );
  }
}
if (process.env.GITHUB_OUTPUT)
  appendFileSync(process.env.GITHUB_OUTPUT, `release=${release}\nversion=${pkg.version}\n`);
console.log(`${release ? 'Release' : 'No code changes since'} v${pkg.version}`);
