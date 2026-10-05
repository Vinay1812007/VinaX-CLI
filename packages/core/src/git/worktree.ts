import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { projectDataDir, type Env } from '../config/paths.js';

/**
 * Opt-in isolated workspaces: a git worktree on its own branch, outside the repository, where a
 * VinaX session can change files without touching your checkout. You review the result, apply it
 * explicitly, and remove the worktree when done.
 *
 * A worktree isolates *file changes in the checkout*. It is not a security sandbox: commands run
 * there can still read and write anything your user account can (other folders, the network,
 * the shared `.git` directory).
 */
export const WORKTREE_NOT_A_SANDBOX =
  'A worktree keeps file edits out of your checkout; it is not a sandbox: shell commands run there can still reach anything your user account can.';

export interface WorktreeInfo {
  name: string;
  path: string;
  branch: string;
  /** Commit the worktree started from; its changes are measured against it. */
  base: string;
  createdAt: string;
  /** Set after `apply`: the hash of the change that was applied. */
  applied?: { hash: string; at: string };
}

export interface WorktreeFileChange {
  path: string;
  added: number;
  removed: number;
  /** Binary files have no line counts. */
  binary: boolean;
}

export interface WorktreeChanges {
  /** Unified diff (with binary data) from `base` to the worktree as it is now. */
  patch: string;
  files: WorktreeFileChange[];
  /** Identifies this exact change set, to tell whether it was applied. */
  hash: string;
}

export type ApplyResult =
  | { status: 'applied'; files: string[]; patchFile: string; dirtyElsewhere: string[] }
  | { status: 'nothing' }
  | { status: 'conflict'; detail: string; patchFile: string };

export type RemoveResult =
  { status: 'removed'; discarded: number } | { status: 'unapplied'; files: WorktreeFileChange[] };

const NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/;

export class WorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorktreeError';
  }
}

async function git(
  cwd: string,
  args: readonly string[],
  opts: { env?: Record<string, string>; input?: string } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const r = await execa('git', args, {
    cwd,
    reject: false,
    stripFinalNewline: false,
    ...(opts.input === undefined ? {} : { input: opts.input }),
    env: { GIT_TERMINAL_PROMPT: '0', ...opts.env },
  });
  return {
    stdout: typeof r.stdout === 'string' ? r.stdout : '',
    stderr: typeof r.stderr === 'string' ? r.stderr.trim() : '',
    exitCode: r.exitCode ?? 1,
  };
}

async function gitOk(cwd: string, args: readonly string[], what: string): Promise<string> {
  const r = await git(cwd, args);
  if (r.exitCode !== 0)
    throw new WorktreeError(`${what} failed: ${r.stderr || `git ${args.join(' ')}`}`);
  return r.stdout.trim();
}

/** The top folder of the git repository containing `cwd`, or undefined outside one. */
export async function findRepoRoot(cwd: string): Promise<string | undefined> {
  const r = await git(cwd, ['rev-parse', '--show-toplevel']);
  return r.exitCode === 0 ? path.resolve(r.stdout.trim()) : undefined;
}

function parseNumstat(text: string): WorktreeFileChange[] {
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      const [a = '', r = '', ...rest] = l.split('\t');
      const binary = a === '-' && r === '-';
      return {
        path: rest.join('\t'),
        added: binary ? 0 : Number(a),
        removed: binary ? 0 : Number(r),
        binary,
      };
    });
}

/** Worktrees for one repository, kept in VinaX's data folder (outside the repository). */
export class WorktreeManager {
  private readonly dir: string;

  constructor(
    readonly repo: string,
    env: Env = process.env,
  ) {
    this.dir = path.join(projectDataDir(repo, env), 'worktrees');
  }

  private metaFile(name: string): string {
    return path.join(this.dir, `${name}.json`);
  }

  private async readMeta(name: string): Promise<WorktreeInfo | undefined> {
    try {
      return JSON.parse(await fs.readFile(this.metaFile(name), 'utf8')) as WorktreeInfo;
    } catch {
      return undefined;
    }
  }

  private async writeMeta(info: WorktreeInfo): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(this.metaFile(info.name), `${JSON.stringify(info, null, 2)}\n`, {
      mode: 0o600,
    });
  }

  async get(name: string): Promise<WorktreeInfo | undefined> {
    return this.readMeta(name);
  }

  /** Creates `vinax/<name>` from HEAD in a new worktree (HEAD must have a commit). */
  async create(name: string): Promise<WorktreeInfo> {
    if (!NAME.test(name))
      throw new WorktreeError(
        `Worktree names use lowercase letters, digits, ".", "_" and "-" (up to 40): ${name}`,
      );
    if (await this.readMeta(name))
      throw new WorktreeError(`A worktree named ${name} already exists.`);
    const base = await gitOk(this.repo, ['rev-parse', '--verify', 'HEAD'], 'Reading HEAD');
    const branch = `vinax/${name}`;
    const where = path.join(this.dir, name);
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await gitOk(this.repo, ['worktree', 'add', '-b', branch, where, base], 'Creating the worktree');
    const info: WorktreeInfo = {
      name,
      path: where,
      branch,
      base,
      createdAt: new Date().toISOString(),
    };
    await this.writeMeta(info);
    return info;
  }

  /** Returns the named worktree, creating it first when it does not exist yet. */
  async open(name: string): Promise<{ info: WorktreeInfo; created: boolean }> {
    const existing = await this.readMeta(name);
    if (existing) {
      if (
        !(await fs.stat(existing.path).then(
          () => true,
          () => false,
        ))
      )
        throw new WorktreeError(
          `Worktree ${name} is recorded but its folder is gone (${existing.path}). Remove it with: vinax worktree remove ${name} --force`,
        );
      return { info: existing, created: false };
    }
    return { info: await this.create(name), created: true };
  }

  async list(): Promise<WorktreeInfo[]> {
    const names = await fs.readdir(this.dir).catch(() => [] as string[]);
    const out: WorktreeInfo[] = [];
    for (const n of names.filter((f) => f.endsWith('.json')).sort()) {
      const info = await this.readMeta(n.slice(0, -5));
      if (info) out.push(info);
    }
    return out;
  }

  /**
   * Everything the worktree changed since it was created: its commits, uncommitted edits and
   * new files (respecting .gitignore). A temporary index is used, so the worktree is untouched.
   */
  async changes(name: string): Promise<WorktreeChanges> {
    const info = await this.require(name);
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vinax-wt-'));
    const env = { GIT_INDEX_FILE: path.join(tmp, 'index') };
    try {
      for (const args of [
        ['read-tree', 'HEAD'],
        ['add', '-A'],
      ]) {
        const r = await git(info.path, args, { env });
        if (r.exitCode !== 0) throw new WorktreeError(`Reading the worktree failed: ${r.stderr}`);
      }
      const patch = await git(info.path, ['diff', '--cached', '--binary', info.base], { env });
      const stat = await git(info.path, ['diff', '--cached', '--numstat', info.base], { env });
      return {
        patch: patch.stdout,
        files: parseNumstat(stat.stdout),
        hash: createHash('sha256').update(patch.stdout).digest('hex'),
      };
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  /**
   * Applies the worktree's changes to the main checkout's files (not its index). Nothing is
   * written unless the whole change applies cleanly; uncommitted edits to other files stay.
   * The patch is saved next to the worktree so it can also be applied by hand.
   */
  async apply(name: string): Promise<ApplyResult> {
    const info = await this.require(name);
    const change = await this.changes(name);
    if (change.patch.trim() === '') return { status: 'nothing' };
    const patchFile = path.join(this.dir, `${name}.patch`);
    await fs.writeFile(patchFile, change.patch, { mode: 0o600 });
    const check = await git(this.repo, ['apply', '--check', '--binary', patchFile]);
    if (check.exitCode !== 0) return { status: 'conflict', detail: check.stderr, patchFile };
    const status = await git(this.repo, ['status', '--porcelain']);
    const touched = new Set(change.files.map((f) => f.path));
    const dirtyElsewhere = status.stdout
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => l.slice(3))
      .filter((p) => !touched.has(p));
    const applied = await git(this.repo, ['apply', '--binary', patchFile]);
    if (applied.exitCode !== 0) return { status: 'conflict', detail: applied.stderr, patchFile };
    await this.writeMeta({ ...info, applied: { hash: change.hash, at: new Date().toISOString() } });
    return { status: 'applied', files: [...touched], patchFile, dirtyElsewhere };
  }

  /**
   * Deletes the worktree folder and its branch. Refuses while it holds changes that were never
   * applied, unless `force` (which discards them).
   */
  async remove(name: string, opts: { force?: boolean } = {}): Promise<RemoveResult> {
    const info = await this.readMeta(name);
    if (!info) throw new WorktreeError(`No worktree named ${name}.`);
    const exists = await fs.stat(info.path).then(
      () => true,
      () => false,
    );
    let discarded = 0;
    if (exists) {
      const change = await this.changes(name);
      const unapplied = change.files.length > 0 && info.applied?.hash !== change.hash;
      if (unapplied && opts.force !== true) return { status: 'unapplied', files: change.files };
      if (unapplied) discarded = change.files.length;
      await gitOk(this.repo, ['worktree', 'remove', '--force', info.path], 'Removing the worktree');
    } else {
      await git(this.repo, ['worktree', 'prune']);
    }
    await git(this.repo, ['branch', '-D', info.branch]);
    await fs.rm(this.metaFile(name), { force: true });
    await fs.rm(path.join(this.dir, `${name}.patch`), { force: true });
    return { status: 'removed', discarded };
  }

  private async require(name: string): Promise<WorktreeInfo> {
    const info = await this.readMeta(name);
    if (!info) throw new WorktreeError(`No worktree named ${name}. See: vinax worktree list`);
    return info;
  }
}

/** A default name for a new worktree: `task-20260105-143000`. */
export function defaultWorktreeName(now: Date = new Date()): string {
  return `task-${now.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')}`;
}
