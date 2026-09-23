import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_ENTRIES = 500;
const MAX_ENTRY_CHARS = 20_000;

/**
 * Prompt history for one project, stored as JSON lines (one JSON string per line, oldest first).
 * `load()` returns newest first, which is the order Up-arrow walks it.
 */
export class PromptHistory {
  private entries: string[] | undefined;

  constructor(readonly file: string) {}

  static forProject(projectDir: string): PromptHistory {
    return new PromptHistory(path.join(projectDir, 'history.jsonl'));
  }

  async load(): Promise<readonly string[]> {
    if (this.entries) return this.entries;
    let text = '';
    try {
      text = await fs.readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const oldestFirst: string[] = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const v: unknown = JSON.parse(line);
        if (typeof v === 'string') oldestFirst.push(v);
      } catch {
        // skip a corrupt line
      }
    }
    this.entries = oldestFirst.reverse();
    return this.entries;
  }

  /** Adds an entry unless it repeats the most recent one. Trims the file when it grows too long. */
  async add(entry: string): Promise<void> {
    const value = entry.trim();
    if (value === '' || value.length > MAX_ENTRY_CHARS) return;
    const entries = [...(await this.load())];
    if (entries[0] === value) return;
    entries.unshift(value);
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    if (entries.length > MAX_ENTRIES) {
      entries.length = MAX_ENTRIES;
      const body = [...entries]
        .reverse()
        .map((e) => JSON.stringify(e))
        .join('\n');
      await fs.writeFile(this.file, `${body}\n`, 'utf8');
    } else {
      await fs.appendFile(this.file, `${JSON.stringify(value)}\n`, 'utf8');
    }
    this.entries = entries;
  }
}

/** Newest-first entries containing `query` (case-insensitive), for reverse search. */
export function searchHistory(entries: readonly string[], query: string): string[] {
  const q = query.toLowerCase();
  return q === '' ? [...entries] : entries.filter((e) => e.toLowerCase().includes(q));
}
