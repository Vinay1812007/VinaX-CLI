import fs from 'node:fs/promises';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { isInside, toPosix } from './paths.js';

export const ALWAYS_IGNORED = ['.git', 'node_modules'];

/**
 * `.gitignore` rules of the project root (plus `.git/info/exclude`), with `.git` and
 * `node_modules` always excluded. Paths outside the root are never filtered.
 */
export class IgnoreFilter {
  private constructor(
    private readonly root: string,
    private readonly ig: Ignore,
  ) {}

  static async load(root: string): Promise<IgnoreFilter> {
    const ig = ignore().add(ALWAYS_IGNORED);
    for (const file of ['.gitignore', path.join('.git', 'info', 'exclude')]) {
      try {
        ig.add(await fs.readFile(path.join(root, file), 'utf8'));
      } catch {
        // not present
      }
    }
    return new IgnoreFilter(root, ig);
  }

  ignores(absPath: string, isDir = false): boolean {
    if (!isInside(absPath, this.root) || absPath === this.root) return false;
    const rel = toPosix(path.relative(this.root, absPath));
    return this.ig.ignores(isDir ? `${rel}/` : rel);
  }
}
