import fs from 'node:fs/promises';
import path from 'node:path';

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

  beginTurn(turn: number): void {
    this.turns.push({ turn, files: new Map() });
  }

  async capture(paths: readonly string[]): Promise<void> {
    const current = this.turns.at(-1);
    if (!current) return;
    for (const file of paths) {
      if (current.files.has(file)) continue;
      try {
        current.files.set(file, await fs.readFile(file, 'utf8'));
      } catch {
        current.files.set(file, null);
      }
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
    const keep = this.turns.filter((t) => t.turn < turn);
    this.turns.length = 0;
    this.turns.push(...keep);
  }
}
