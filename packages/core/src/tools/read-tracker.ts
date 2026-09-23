import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';

interface Seen {
  hash: string;
}

function hashOf(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Remembers which files the model has read and what they contained, so Write and Edit can refuse
 * to change a file the model has not seen, or one that changed on disk since it was read.
 */
export class ReadTracker {
  private readonly seen = new Map<string, Seen>();

  record(file: string, content: string): void {
    this.seen.set(file, { hash: hashOf(content) });
  }

  forget(file: string): void {
    this.seen.delete(file);
  }

  /** Returns an error message, or `undefined` when the file may be modified. */
  async checkFresh(file: string): Promise<string | undefined> {
    const seen = this.seen.get(file);
    if (!seen)
      return 'Read the file first: files must be read with the Read tool before they are changed.';
    let current: string;
    try {
      current = await fs.readFile(file, 'utf8');
    } catch {
      return 'The file no longer exists. Read the directory again before changing it.';
    }
    if (hashOf(current) !== seen.hash) {
      return 'The file changed on disk since you read it. Read it again, then retry the change.';
    }
    return undefined;
  }
}
