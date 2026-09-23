import fs from 'node:fs/promises';
import path from 'node:path';
import type { SessionRecorder } from '../session/store.js';

/** File contents before a turn first changed them; `null` means the file did not exist. */
interface TurnSnapshot {
  turn: number;
  files: Map<string, string | null>;
}

/**
 * Snapshots files before the first change in each turn so the rewind picker can put the
 * working tree back. Only changes made through VinaX's file tools are covered, not Bash.
 */
export class CheckpointStore {
  private readonly turns: TurnSnapshot[] = [];

  constructor(private readonly recorder?: SessionRecorder) {}

  /** Restores snapshots from a saved session. */
  load(saved: ReadonlyMap<number, ReadonlyMap<string, string | null>>): void {
    this.turns.length = 0;
    for (const [turn, files] of [...saved.entries()].sort(([a], [b]) => a - b)) {
      this.turns.push({ turn, files: new Map(files) });
    }
  }

  beginTurn(turn: number): void {
    this.turns.push({ turn, files: new Map() });
  }

  async capture(paths: readonly string[]): Promise<void> {
    const current = this.turns.at(-1);
    if (!current) return;
    for (const file of paths) {
      if (current.files.has(file)) continue;
      let content: string | null;
      try {
        content = await fs.readFile(file, 'utf8');
      } catch {
        content = null;
      }
      current.files.set(file, content);
      this.recorder?.record({
        type: 'checkpoint',
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

  /** Restores every file to how it was before `turn`, forgets those snapshots, returns the files. */
  async restoreTo(turn: number): Promise<string[]> {
    const earliest = new Map<string, string | null>();
    for (const t of this.turns) {
      if (t.turn < turn) continue;
      for (const [file, content] of t.files) if (!earliest.has(file)) earliest.set(file, content);
    }
    for (const [file, content] of earliest) {
      if (content === null) await fs.rm(file, { force: true });
      else {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, content, 'utf8');
      }
    }
    this.dropFrom(turn);
    return [...earliest.keys()].sort();
  }

  dropFrom(turn: number): void {
    this.recorder?.record({ type: 'checkpoint_drop', fromTurn: turn });
    const keep = this.turns.filter((t) => t.turn < turn);
    this.turns.length = 0;
    this.turns.push(...keep);
  }
}
