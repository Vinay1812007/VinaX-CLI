import fs from 'node:fs/promises';
import path from 'node:path';
import type { SessionRecorder } from '../session/store.js';

/** A file's text content; `null` means the file did not exist. */
export type FileState = string | null;

interface FileSnapshot {
  /** Content before the turn first changed the file. */
  before: FileState;
  /** Content right after VinaX's latest change in the turn; `undefined` = not recorded. */
  after: FileState | undefined;
}

interface TurnSnapshot {
  turn: number;
  files: Map<string, FileSnapshot>;
}

/** Thrown when a file cannot be snapshotted, so the change is not made (it could not be undone). */
export class CheckpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckpointError';
  }
}

/**
 * - `clean`: the file is exactly as VinaX left it.
 * - `modified`: it changed outside VinaX (an editor, a Bash command) after VinaX last wrote it.
 * - `unverified`: VinaX has no record of what it wrote (an older session, or the change failed),
 *   so outside edits cannot be ruled out.
 */
export type RestoreStatus = 'clean' | 'modified' | 'unverified';

export interface RestoreFilePlan {
  file: string;
  /** What restoring does to the file; `none` when it already has the old content. */
  action: 'write' | 'delete' | 'none';
  status: RestoreStatus;
  /** Why the file needs a decision (for `modified` and `unverified`). */
  reason?: string;
  /** The content on disk now (`null` = absent, `undefined` = could not be read). */
  current: FileState | undefined;
  /** The content the file goes back to. */
  target: FileState;
}

export interface RestorePlan {
  turn: number;
  files: RestoreFilePlan[];
  /** Files whose current content would be lost without the user agreeing to it. */
  conflicts: RestoreFilePlan[];
}

/**
 * How to treat conflicting files:
 * - `abort` (default): change nothing when any file conflicts; the plan is returned instead.
 * - `keep`: restore the clean files and leave the conflicting ones as they are.
 * - `overwrite`: restore everything; the current versions are saved to the backup folder first.
 */
export type ConflictResolution = 'abort' | 'keep' | 'overwrite';

export interface RestoreResult {
  status: 'restored' | 'conflicts' | 'failed';
  /** Files put back to their earlier content. */
  restored: string[];
  /** Conflicting files left untouched (`keep`). */
  kept: string[];
  conflicts: RestoreFilePlan[];
  /** Folder holding copies of every file as it was just before the restore. */
  backup?: string;
  /** For `failed`: what went wrong, and whether the files already written were put back. */
  error?: string;
  rolledBack?: boolean;
}

/** One file VinaX changed this session: as it was before the first change, and as VinaX left it. */
export interface SessionFileChange {
  file: string;
  /** First turn that changed it (undo goes back to before this turn). */
  firstTurn: number;
  turns: number[];
  original: FileState;
  /** What VinaX last wrote (`undefined` = not recorded). */
  latest: FileState | undefined;
}

const KEEP_BACKUPS = 20;

async function readState(file: string): Promise<FileState> {
  try {
    const buf = await fs.readFile(file);
    const text = buf.toString('utf8');
    // a snapshot must restore the exact bytes; text that does not survive decoding would not
    if (!Buffer.from(text, 'utf8').equals(buf))
      throw new CheckpointError(
        `${file} is not UTF-8 text, so VinaX cannot snapshot it for rewind; the change was not made. Change binary files with Bash instead.`,
      );
    return text;
  } catch (err) {
    if (err instanceof CheckpointError) throw err;
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    const code = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
    throw new CheckpointError(
      `Could not snapshot ${file} before changing it (${code}), so the change was not made: VinaX only changes files it can restore.`,
    );
  }
}

/** Reads the current state for a plan: like readState, but an unreadable file is `undefined`. */
async function peekState(file: string): Promise<FileState | undefined> {
  try {
    return await readState(file);
  } catch {
    return undefined;
  }
}

async function writeState(file: string, content: FileState): Promise<void> {
  if (content === null) {
    await fs.rm(file, { force: true });
    return;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, 'utf8');
}

/**
 * Snapshots files before the first change in each turn so the rewind picker can put the
 * working tree back, and records what VinaX wrote so edits made outside VinaX are noticed before
 * anything is overwritten. Only changes made through VinaX's file tools are covered: effects of
 * Bash commands (and anything else outside VinaX) are not snapshotted and cannot be undone.
 */
export class CheckpointStore {
  private readonly turns: TurnSnapshot[] = [];

  constructor(
    private readonly recorder?: SessionRecorder,
    /** Where pre-restore copies go; without it, copies are kept in memory for rollback only. */
    private readonly backupDir?: string,
  ) {}

  /** Restores snapshots (and, for newer sessions, what VinaX wrote) from a saved session. */
  load(
    saved: ReadonlyMap<number, ReadonlyMap<string, FileState>>,
    results: ReadonlyMap<number, ReadonlyMap<string, FileState>> = new Map(),
  ): void {
    this.turns.length = 0;
    for (const [turn, files] of [...saved.entries()].sort(([a], [b]) => a - b)) {
      const after = results.get(turn);
      this.turns.push({
        turn,
        files: new Map(
          [...files].map(([file, before]) => [
            file,
            { before, after: after?.has(file) === true ? after.get(file) : undefined },
          ]),
        ),
      });
    }
  }

  beginTurn(turn: number): void {
    this.turns.push({ turn, files: new Map() });
  }

  /**
   * Snapshots `paths` before a tool changes them. Throws CheckpointError when a file exists but
   * cannot be read, rather than recording it as missing (a rewind would then delete it).
   */
  async capture(paths: readonly string[]): Promise<void> {
    const current = this.turns.at(-1);
    if (!current) return;
    for (const file of paths) {
      if (current.files.has(file)) continue;
      const content = await readState(file);
      current.files.set(file, { before: content, after: undefined });
      this.recorder?.record({
        type: 'checkpoint',
        turn: current.turn,
        file,
        blob: content === null ? null : this.recorder.storeBlob(content),
      });
    }
  }

  /** Records what `paths` contain after a tool ran, so later outside edits can be told apart. */
  async recordResult(paths: readonly string[]): Promise<void> {
    const current = this.turns.at(-1);
    if (!current) return;
    for (const file of paths) {
      const snap = current.files.get(file);
      if (!snap) continue;
      const content = await peekState(file);
      snap.after = content;
      if (content === undefined) continue;
      this.recorder?.record({
        type: 'checkpoint_result',
        turn: current.turn,
        file,
        blob: content === null ? null : this.recorder.storeBlob(content),
      });
    }
  }

  /** Files changed by VinaX in `turn` and every later turn. */
  changedSince(turn: number): string[] {
    const files = new Set<string>();
    for (const t of this.turns) if (t.turn >= turn) for (const f of t.files.keys()) files.add(f);
    return [...files].sort();
  }

  /** Every file VinaX changed in the turns it can still restore, in path order. */
  sessionChanges(): SessionFileChange[] {
    const byFile = new Map<string, SessionFileChange>();
    for (const t of this.turns) {
      for (const [file, snap] of t.files) {
        const seen = byFile.get(file);
        if (seen) {
          seen.turns.push(t.turn);
          seen.latest = snap.after;
        } else
          byFile.set(file, {
            file,
            firstTurn: t.turn,
            turns: [t.turn],
            original: snap.before,
            latest: snap.after,
          });
      }
    }
    return [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file));
  }

  /** What restoring to before `turn` would do, file by file (all files, or only `only`). */
  async planRestore(turn: number, only?: readonly string[]): Promise<RestorePlan> {
    const history = new Map<string, FileSnapshot[]>();
    for (const t of this.turns) {
      if (t.turn < turn) continue;
      for (const [file, snap] of t.files) {
        if (only !== undefined && !only.includes(file)) continue;
        const list = history.get(file) ?? [];
        list.push(snap);
        history.set(file, list);
      }
    }
    const files: RestoreFilePlan[] = [];
    for (const [file, snaps] of [...history].sort(([a], [b]) => a.localeCompare(b))) {
      const target = snaps[0]?.before ?? null;
      const current = await peekState(file);
      let status: RestoreStatus = 'clean';
      let reason: string | undefined;
      const latest = snaps.at(-1)?.after;
      // an edit made between two VinaX turns would be lost too
      const between = snaps.findIndex(
        (s, i) => i > 0 && snaps[i - 1]?.after !== undefined && snaps[i - 1]?.after !== s.before,
      );
      if (current === undefined) {
        status = 'modified';
        reason = 'cannot be read now';
      } else if (latest === undefined) {
        status = 'unverified';
        reason = 'VinaX has no record of its last change to it (older session or a failed edit)';
      } else if (current !== latest) {
        status = 'modified';
        reason =
          current === null
            ? 'deleted since VinaX changed it'
            : 'edited since VinaX changed it (by you, another program or a shell command)';
      } else if (between !== -1) {
        status = 'modified';
        reason = 'edited outside VinaX between two of its changes';
      }
      const action = current === target ? 'none' : target === null ? 'delete' : 'write';
      // a file that already has the old content loses nothing
      if (action === 'none') {
        status = 'clean';
        reason = undefined;
      }
      files.push({
        file,
        action,
        status,
        ...(reason === undefined ? {} : { reason }),
        current,
        target,
      });
    }
    return { turn, files, conflicts: files.filter((f) => f.status !== 'clean') };
  }

  /**
   * Restores files to how they were before `turn`. Nothing is overwritten that changed outside
   * VinaX unless `resolution` says so. Every file is copied to a backup folder before it is
   * written, and if a write fails the files already written are put back.
   */
  async restoreTo(
    turn: number,
    opts: { resolution?: ConflictResolution; only?: readonly string[] } = {},
  ): Promise<RestoreResult> {
    const resolution = opts.resolution ?? 'abort';
    const plan = await this.planRestore(turn, opts.only);
    if (plan.conflicts.length > 0 && resolution === 'abort')
      return { status: 'conflicts', restored: [], kept: [], conflicts: plan.conflicts };
    const kept = resolution === 'keep' ? plan.conflicts.filter((f) => f.action !== 'none') : [];
    const todo = plan.files.filter((f) => f.action !== 'none' && !kept.includes(f));
    const unreadable = todo.find((f) => f.current === undefined);
    if (unreadable)
      return {
        status: 'failed',
        restored: [],
        kept: [],
        conflicts: plan.conflicts,
        error: `${unreadable.file} cannot be read, so it cannot be backed up before restoring. Nothing was changed.`,
        rolledBack: true,
      };
    let backup: string | undefined;
    try {
      backup = await this.writeBackup(turn, todo);
    } catch (err) {
      return {
        status: 'failed',
        restored: [],
        kept: [],
        conflicts: plan.conflicts,
        error: `Could not save backups before restoring (${(err as Error).message}). Nothing was changed.`,
        rolledBack: true,
      };
    }
    const done: RestoreFilePlan[] = [];
    for (const f of todo) {
      try {
        await writeState(f.file, f.target);
        done.push(f);
      } catch (err) {
        const rollbackErrors: string[] = [];
        for (const d of done.reverse()) {
          try {
            await writeState(d.file, d.current ?? null);
          } catch (e) {
            rollbackErrors.push(`${d.file}: ${(e as Error).message}`);
          }
        }
        return {
          status: 'failed',
          restored: [],
          kept: [],
          conflicts: plan.conflicts,
          ...(backup === undefined ? {} : { backup }),
          error: `Could not restore ${f.file} (${(err as Error).message}).${
            rollbackErrors.length === 0
              ? ' The files already restored were put back, so nothing changed.'
              : ` Putting back the files already restored also failed (${rollbackErrors.join('; ')})${backup === undefined ? '' : `; their earlier versions are in ${backup}`}.`
          }`,
          rolledBack: rollbackErrors.length === 0,
        };
      }
    }
    if (opts.only === undefined) this.dropFrom(turn);
    else for (const f of plan.files) if (!kept.includes(f)) this.forget(f.file, turn);
    return {
      status: 'restored',
      restored: done.map((f) => f.file),
      kept: kept.map((f) => f.file),
      conflicts: plan.conflicts,
      ...(backup === undefined ? {} : { backup }),
    };
  }

  /** Copies the files about to be overwritten to a fresh backup folder (newest 20 are kept). */
  private async writeBackup(
    turn: number,
    files: readonly RestoreFilePlan[],
  ): Promise<string | undefined> {
    if (this.backupDir === undefined || files.length === 0) return undefined;
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
    let dir = path.join(this.backupDir, `${stamp}-turn${String(turn)}`);
    for (
      let n = 2;
      await fs.stat(dir).then(
        () => true,
        () => false,
      );
      n++
    )
      dir = path.join(this.backupDir, `${stamp}-turn${String(turn)}-${String(n)}`);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const manifest = files.map((f, i) => ({
      file: f.file,
      existed: f.current !== null,
      copy: f.current === null ? null : `${String(i)}-${path.basename(f.file)}`,
    }));
    for (const [i, f] of files.entries()) {
      const copy = manifest[i]?.copy;
      if (copy && typeof f.current === 'string')
        await fs.writeFile(path.join(dir, copy), f.current, { mode: 0o600 });
    }
    await fs.writeFile(
      path.join(dir, 'manifest.json'),
      `${JSON.stringify({ turn, createdAt: new Date().toISOString(), files: manifest }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await this.pruneBackups();
    return dir;
  }

  private async pruneBackups(): Promise<void> {
    if (this.backupDir === undefined) return;
    const names = (await fs.readdir(this.backupDir).catch(() => [] as string[])).sort();
    for (const old of names.slice(0, Math.max(0, names.length - KEEP_BACKUPS)))
      await fs.rm(path.join(this.backupDir, old), { recursive: true, force: true });
  }

  dropFrom(turn: number): void {
    this.recorder?.record({ type: 'checkpoint_drop', fromTurn: turn });
    const keep = this.turns.filter((t) => t.turn < turn);
    this.turns.length = 0;
    this.turns.push(...keep);
  }

  /** Stops tracking one file from `turn` on (after it was undone on its own). */
  private forget(file: string, turn: number): void {
    this.recorder?.record({ type: 'checkpoint_forget', fromTurn: turn, file });
    for (const t of this.turns) if (t.turn >= turn) t.files.delete(file);
  }
}
