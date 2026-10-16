import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vinaxHome, type Env } from '../config/paths.js';
import type { SandboxMode } from '../config/schema.js';

/** A command line after sandboxing: the program to start and its arguments. */
export interface SpawnSpec {
  file: string;
  args: string[];
}

export type Sandbox =
  | { mode: 'off' }
  | {
      mode: Exclude<SandboxMode, 'off'>;
      /** macOS Seatbelt (`sandbox-exec`) or Linux bubblewrap (`bwrap`). */
      kind: 'seatbelt' | 'bwrap';
      wrap: (spec: SpawnSpec) => SpawnSpec;
    }
  | {
      mode: Exclude<SandboxMode, 'off'>;
      /** Why commands cannot be sandboxed here; the Bash tool refuses to run them. */
      unavailable: string;
    };

export interface SandboxOptions {
  /** Folders commands may write in workspace-write mode (the project and `--add-dir`s). */
  workspace: () => readonly string[];
  env?: Env;
  platform?: NodeJS.Platform;
  /** Finds a program on PATH; injectable for tests. */
  which?: (program: string) => string | undefined;
  /** Resolves symlinks (macOS's /tmp is /private/tmp); injectable for tests. */
  realpath?: (p: string) => string;
  /** Temporary folders commands may always write to; default $TMPDIR, os.tmpdir() and /tmp. */
  tempDirs?: readonly string[];
}

/** Looks a program up on PATH, like `which`. */
export function whichSync(program: string, env: Env = process.env): string | undefined {
  const dirs = (env.PATH ?? '').split(path.delimiter).filter((d) => d !== '');
  for (const dir of dirs) {
    const file = path.join(dir, program);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch {
      // not here
    }
  }
  return undefined;
}

function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * A git worktree keeps its repository data in the main checkout's `.git` folder; commits made in
 * the worktree write there, so it must be writable too.
 */
export function gitDirsFor(dir: string): string[] {
  try {
    const dotGit = path.join(dir, '.git');
    if (!fs.statSync(dotGit).isFile()) return [];
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
    if (!m?.[1]) return [];
    const gitdir = path.resolve(dir, m[1].trim());
    // <main>/.git/worktrees/<name> → <main>/.git
    return [gitdir, path.resolve(gitdir, '..', '..')];
  } catch {
    return [];
  }
}

/** Folders a sandboxed command may write to, symlinks resolved and duplicates removed. */
export function writableRoots(
  mode: Exclude<SandboxMode, 'off'>,
  opts: {
    workspace: readonly string[];
    env: Env;
    realpath: (p: string) => string;
    tempDirs?: readonly string[];
  },
): string[] {
  const temp = (opts.tempDirs ?? [opts.env.TMPDIR, os.tmpdir(), '/tmp']).filter(
    (d): d is string => d !== undefined && d !== '',
  );
  const project =
    mode === 'workspace-write'
      ? [...opts.workspace, ...opts.workspace.flatMap((d) => gitDirsFor(d)), vinaxHome(opts.env)]
      : [];
  return [...new Set([...project, ...temp].map((d) => opts.realpath(d)))];
}

/** `"a\"b"` for a Seatbelt profile string literal. */
function sbString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * A Seatbelt profile like Codex's: everything is allowed except writing outside `writable`
 * (and the terminal devices), and in read-only mode, network access other than local sockets.
 */
export function seatbeltProfile(mode: Exclude<SandboxMode, 'off'>, writable: readonly string[]) {
  const roots = [...writable.map((d) => `(subpath ${sbString(d)})`), '(subpath "/dev")'];
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* ${roots.join(' ')})`,
    ...(mode === 'read-only' ? ['(deny network*)', '(allow network* (remote unix-socket))'] : []),
  ].join('\n');
}

/** bubblewrap arguments: the whole filesystem read-only, `writable` bound read-write. */
export function bwrapArgs(mode: Exclude<SandboxMode, 'off'>, writable: readonly string[]) {
  return [
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    ...writable.filter((d) => fs.existsSync(d)).flatMap((d) => ['--bind', d, d]),
    ...(mode === 'read-only' ? ['--unshare-net'] : []),
    '--die-with-parent',
    '--new-session',
    '--',
  ];
}

/**
 * How Bash commands are confined. `off` runs them as they are; otherwise macOS uses
 * `sandbox-exec` and Linux `bwrap`. Where neither exists the sandbox is unavailable and the
 * Bash tool refuses to run commands rather than silently running them unconfined.
 */
export function createSandbox(mode: SandboxMode, opts: SandboxOptions): Sandbox {
  if (mode === 'off') return { mode };
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const which = opts.which ?? ((p: string) => whichSync(p, env));
  const realpath = opts.realpath ?? safeRealpath;
  const roots = () =>
    writableRoots(mode, {
      workspace: opts.workspace(),
      env,
      realpath,
      ...(opts.tempDirs === undefined ? {} : { tempDirs: opts.tempDirs }),
    });
  if (platform === 'darwin') {
    const exe =
      which('sandbox-exec') ??
      (fs.existsSync('/usr/bin/sandbox-exec') ? '/usr/bin/sandbox-exec' : undefined);
    if (exe === undefined)
      return { mode, unavailable: 'sandbox-exec was not found, so commands cannot be sandboxed.' };
    return {
      mode,
      kind: 'seatbelt',
      wrap: (spec) => ({
        file: exe,
        args: ['-p', seatbeltProfile(mode, roots()), spec.file, ...spec.args],
      }),
    };
  }
  if (platform === 'linux') {
    const exe = which('bwrap');
    if (exe === undefined)
      return {
        mode,
        unavailable:
          'bubblewrap (bwrap) is not installed, so commands cannot be sandboxed. Install it (e.g. apt install bubblewrap) or set "sandbox": "off".',
      };
    return {
      mode,
      kind: 'bwrap',
      wrap: (spec) => ({ file: exe, args: [...bwrapArgs(mode, roots()), spec.file, ...spec.args] }),
    };
  }
  return {
    mode,
    unavailable: `sandboxing is not supported on ${platform}; set "sandbox": "off" to run commands unsandboxed.`,
  };
}

/** Text for the Bash tool when the sandbox is unavailable. */
export function sandboxRefusal(sandbox: Sandbox): string | undefined {
  return 'unavailable' in sandbox
    ? `Not run: the ${sandbox.mode} sandbox is on but ${sandbox.unavailable}`
    : undefined;
}
