import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_URL, type Env } from '@vinax/core';

/** Set by scripts/build-binaries.ts to the release asset this binary was built as, e.g. linux-x64. */
declare const __VINAX_TARGET__: string | undefined;

const REPO_API = PROJECT_URL.replace('https://github.com/', 'https://api.github.com/repos/');
const NPM_PACKAGE = 'vinax';

export type InstallKind =
  { kind: 'binary'; path: string; target: string } | { kind: 'npm' } | { kind: 'source' };

/** The real path of the running script (npm installs `vinax` as a symlink into node_modules). */
function runningScript(): string {
  const script = process.argv[1] ?? '';
  try {
    return realpathSync(script);
  } catch {
    return script;
  }
}

export function binaryTarget(): string | undefined {
  return typeof __VINAX_TARGET__ === 'string' ? __VINAX_TARGET__ : undefined;
}

/** How this copy of VinaX was installed, which decides how it updates. */
export function detectInstall(
  target = binaryTarget(),
  execPath = process.execPath,
  script = runningScript(),
): InstallKind {
  if (target !== undefined) return { kind: 'binary', path: execPath, target };
  const norm = script.split(path.sep).join('/');
  if (norm.includes(`/node_modules/${NPM_PACKAGE}/`)) return { kind: 'npm' };
  return { kind: 'source' };
}

/** Compares `x.y.z[-pre]` versions; a pre-release sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = '', pre] = v.replace(/^v/, '').split('-', 2);
    return { nums: core.split('.').map((n) => Number(n) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
}

export interface Release {
  version: string;
  assets: Map<string, string>;
}

async function getJson(url: string, fetchFn: typeof fetch): Promise<unknown> {
  const res = await fetchFn(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'vinax-cli' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${url} answered HTTP ${String(res.status)}`);
  return res.json();
}

/** The latest GitHub release (`VINAX_UPDATE_URL` points elsewhere, e.g. a mirror). */
export async function latestRelease(env: Env, fetchFn: typeof fetch = fetch): Promise<Release> {
  const url = env.VINAX_UPDATE_URL ?? `${REPO_API}/releases/latest`;
  const body = (await getJson(url, fetchFn).catch((err: unknown) => {
    if (err instanceof Error && err.message.endsWith('HTTP 404'))
      throw new Error('no VinaX release has been published yet');
    throw err;
  })) as {
    tag_name?: unknown;
    assets?: { name?: unknown; browser_download_url?: unknown }[];
  };
  if (typeof body.tag_name !== 'string') throw new Error('The release has no tag.');
  const assets = new Map<string, string>();
  for (const a of body.assets ?? []) {
    if (typeof a.name === 'string' && typeof a.browser_download_url === 'string')
      assets.set(a.name, a.browser_download_url);
  }
  return { version: body.tag_name.replace(/^v/, ''), assets };
}

/** The version npm would install. */
export async function latestNpmVersion(env: Env, fetchFn: typeof fetch = fetch): Promise<string> {
  const registry = (env.npm_config_registry ?? 'https://registry.npmjs.org').replace(/\/$/, '');
  const body = (await getJson(`${registry}/${NPM_PACKAGE}/latest`, fetchFn).catch(
    (err: unknown) => {
      if (err instanceof Error && err.message.endsWith('HTTP 404'))
        throw new Error(`${NPM_PACKAGE} is not published on npm yet`);
      throw err;
    },
  )) as {
    version?: unknown;
  };
  if (typeof body.version !== 'string') throw new Error('npm returned no version.');
  return body.version;
}

async function download(url: string, fetchFn: typeof fetch): Promise<Buffer> {
  const res = await fetchFn(url, {
    headers: { 'User-Agent': 'vinax-cli' },
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!res.ok) throw new Error(`Downloading ${url} failed: HTTP ${String(res.status)}`);
  return Buffer.from(await res.arrayBuffer());
}

function runVersion(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, ['--version'], { timeout: 30_000 }, (err: Error | null, stdout: string) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

/**
 * Replaces the running binary with the release's build for the same target, after checking it
 * against the release's SHA256SUMS. On Windows the running file cannot be overwritten, so it is
 * moved aside to `<name>.old` (removed on the next start).
 */
export async function updateBinary(
  install: { path: string; target: string },
  release: Release,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const windows = install.target.startsWith('windows');
  const asset = `vinax-${install.target}${windows ? '.exe' : ''}`;
  const url = release.assets.get(asset);
  const sumsUrl = release.assets.get('SHA256SUMS');
  if (url === undefined) throw new Error(`Release v${release.version} has no ${asset}.`);
  if (sumsUrl === undefined) throw new Error(`Release v${release.version} has no SHA256SUMS.`);
  const sums = (await download(sumsUrl, fetchFn)).toString('utf8');
  const expected = sums
    .split('\n')
    .map((l) => l.trim().split(/\s+\*?/))
    .find(([, name]) => name === asset)?.[0];
  if (expected === undefined) throw new Error(`SHA256SUMS does not list ${asset}.`);
  const data = await download(url, fetchFn);
  const actual = createHash('sha256').update(data).digest('hex');
  if (actual !== expected.toLowerCase())
    throw new Error(
      `The download of ${asset} is corrupt (checksum mismatch); nothing was changed.`,
    );

  const next = `${install.path}.new`;
  await fs.writeFile(next, data, { mode: 0o755 });
  if (windows) {
    const old = `${install.path}.old`;
    await fs.rm(old, { force: true });
    await fs.rename(install.path, old);
    try {
      await fs.rename(next, install.path);
    } catch (err) {
      await fs.rename(old, install.path);
      throw err;
    }
  } else {
    await fs.rename(next, install.path);
  }
}

/** Removes the binary a Windows update moved aside. */
export async function cleanupOldBinary(install: InstallKind): Promise<void> {
  if (install.kind === 'binary')
    await fs.rm(`${install.path}.old`, { force: true }).catch(() => undefined);
}

export interface UpdateIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

/** `vinax update`: checks for a newer release and installs it the same way VinaX was installed. */
export async function runUpdate(
  current: string,
  opts: { check: boolean; env: Env; install?: InstallKind; fetch?: typeof fetch },
  io: UpdateIO,
): Promise<number> {
  const install = opts.install ?? detectInstall();
  const fetchFn = opts.fetch ?? fetch;
  if (install.kind === 'source') {
    io.out(`VinaX v${current} is running from a source checkout.`);
    io.out('Update it with: git pull && pnpm install && pnpm build');
    return 0;
  }
  let latest: string;
  let release: Release | undefined;
  try {
    if (install.kind === 'binary') {
      release = await latestRelease(opts.env, fetchFn);
      latest = release.version;
    } else {
      latest = await latestNpmVersion(opts.env, fetchFn);
    }
  } catch (err) {
    io.err(`✖ Could not check for updates: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (compareVersions(latest, current) <= 0) {
    io.out(`✔ VinaX v${current} is up to date.`);
    return 0;
  }
  if (opts.check) {
    io.out(`VinaX v${latest} is available (you have v${current}). Run: vinax update`);
    return 0;
  }
  io.out(`Updating VinaX v${current} → v${latest}…`);
  if (install.kind === 'npm') {
    const code = await new Promise<number>((resolve) => {
      const child = spawn('npm', ['install', '--global', `${NPM_PACKAGE}@${latest}`], {
        stdio: 'inherit',
        shell: process.platform === 'win32',
      });
      child.on('error', () => {
        resolve(127);
      });
      child.on('close', (c) => {
        resolve(c ?? 1);
      });
    });
    if (code !== 0) {
      io.err(
        `✖ npm install failed. Run it yourself (with sudo if your global folder needs it): npm install -g ${NPM_PACKAGE}@${latest}`,
      );
      return 1;
    }
    io.out(`✔ Updated to v${latest}.`);
    return 0;
  }
  try {
    if (!release) throw new Error('no release information');
    await updateBinary(install, release, fetchFn);
    const reported = await runVersion(install.path).catch(() => undefined);
    io.out(`✔ Updated ${install.path} to v${reported ?? latest}.`);
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const denied = (err as NodeJS.ErrnoException).code === 'EACCES';
    io.err(
      `✖ ${denied ? `No permission to replace ${install.path}. Re-run the install script, or run vinax update with the needed rights.` : message}`,
    );
    return 1;
  }
}
