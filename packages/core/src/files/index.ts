import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import { IgnoreFilter } from '../tools/ignore-filter.js';
import { displayPath, inWorkspace, resolvePath, toPosix } from '../tools/paths.js';
import type { ReadTracker } from '../tools/read-tracker.js';

const MAX_FILES = 20_000;
const CACHE_MS = 15_000;
const ATTACH_MAX_LINES = 400;
const ATTACH_MAX_CHARS = 8000;

/**
 * Fuzzy match score (higher is better), or undefined when `query` is not a subsequence of
 * `candidate`. Rewards matches in the file name, at word starts and in runs.
 */
export function fuzzyScore(query: string, candidate: string): number | undefined {
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  if (q === '') return 0;
  const base = c.lastIndexOf('/') + 1;
  let score = 0;
  let ci = 0;
  let prev = -2;
  for (const ch of q) {
    const at = c.indexOf(ch, ci);
    if (at === -1) return undefined;
    score += 1;
    if (at === prev + 1) score += 3;
    if (at >= base) score += 2;
    if (at === 0 || '/_-. '.includes(c[at - 1] ?? '')) score += 3;
    prev = at;
    ci = at + 1;
  }
  if (c.slice(base).startsWith(q)) score += 10;
  return score - candidate.length * 0.05;
}

/** Project files and folders for `@` completion, respecting .gitignore; cached briefly. */
export class FileIndex {
  private cache: { at: number; paths: string[] } | undefined;

  constructor(private readonly cwd: string) {}

  async list(): Promise<string[]> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.paths;
    const filter = await IgnoreFilter.load(this.cwd);
    const entries = await fg('**/*', {
      cwd: this.cwd,
      dot: true,
      onlyFiles: false,
      markDirectories: true,
      followSymbolicLinks: false,
      ignore: ['**/.git/**', '**/node_modules/**'],
      suppressErrors: true,
    });
    const paths = entries
      .filter((p) => !filter.ignores(path.join(this.cwd, p), p.endsWith('/')))
      .slice(0, MAX_FILES);
    this.cache = { at: Date.now(), paths };
    return paths;
  }

  async search(query: string, limit = 8): Promise<string[]> {
    const scored: { p: string; s: number }[] = [];
    for (const p of await this.list()) {
      const s = fuzzyScore(query, p);
      if (s !== undefined) scored.push({ p, s });
    }
    return scored
      .sort((a, b) => b.s - a.s || a.p.length - b.p.length)
      .slice(0, limit)
      .map((x) => x.p);
  }
}

/**
 * Attaches the files and folders mentioned as `@path` in a prompt: their contents (line
 * numbered, like the Read tool) are appended, and files count as read so they can be edited.
 */
export async function attachMentions(
  prompt: string,
  ctx: { cwd: string; workspace: readonly string[]; reads: ReadTracker },
): Promise<{ prompt: string; attached: string[] }> {
  const refs = [
    ...new Set(
      [...prompt.matchAll(/(?:^|\s)@((?:~\/|\.{0,2}\/)?[^\s`'"]+)/g)].map((m) => m[1] ?? ''),
    ),
  ];
  const blocks: string[] = [];
  const attached: string[] = [];
  for (const ref of refs) {
    const clean = ref.replace(/[.,;:!?)]+$/, '');
    const target = resolvePath(clean, ctx.cwd);
    if (!inWorkspace(target, ctx.workspace)) continue;
    const stat = await fs.stat(target).catch(() => undefined);
    if (!stat) continue;
    const shown = displayPath(target, ctx.cwd);
    if (stat.isDirectory()) {
      const names = (await fs.readdir(target, { withFileTypes: true }))
        .filter((e) => e.name !== '.git' && e.name !== 'node_modules')
        .map((e) => `${e.name}${e.isDirectory() ? '/' : ''}`)
        .sort()
        .slice(0, 200);
      blocks.push(`<folder path="${shown}">\n${names.join('\n')}\n</folder>`);
      attached.push(`${toPosix(shown)}/`);
      continue;
    }
    if (stat.size > 2_000_000) continue;
    const buf = await fs.readFile(target);
    if (buf.subarray(0, 8000).includes(0)) continue;
    const text = buf.toString('utf8');
    ctx.reads.record(target, text);
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const numbered = lines
      .slice(0, ATTACH_MAX_LINES)
      .map((l, i) => `${String(i + 1).padStart(6)}\t${l}`)
      .join('\n');
    const clipped =
      numbered.length > ATTACH_MAX_CHARS
        ? `${numbered.slice(0, ATTACH_MAX_CHARS)}\n[… truncated; use Read with offset for the rest]`
        : numbered;
    const more =
      lines.length > ATTACH_MAX_LINES
        ? `\n[… ${String(lines.length - ATTACH_MAX_LINES)} more lines; use Read with offset]`
        : '';
    blocks.push(`<file path="${shown}">\n${clipped}${more}\n</file>`);
    attached.push(toPosix(shown));
  }
  return { prompt: blocks.length === 0 ? prompt : `${prompt}\n\n${blocks.join('\n\n')}`, attached };
}
