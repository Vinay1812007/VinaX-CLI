import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { IgnoreFilter } from '../tools/ignore-filter.js';
import { displayPath, inWorkspace, isInside, resolvePath, toPosix } from '../tools/paths.js';
import type { ReadTracker } from '../tools/read-tracker.js';

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

/**
 * Folders never indexed for `@` completion: dependencies, build output, caches and (in a home
 * folder) system data. They can still be reached by typing their path (`@dist/`).
 */
export const NOISE_DIRS: ReadonlySet<string> = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'bower_components',
  '.pnpm-store',
  '.npm',
  '.yarn',
  '.venv',
  'venv',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.tox',
  '.gradle',
  '.m2',
  '.cargo',
  '.rustup',
  'target',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'Caches',
  'Library',
  '.Trash',
  'Applications',
  '.vscode-server',
  '.docker',
  'DerivedData',
  'Pods',
]);

/** macOS bundles are folders on disk but files to people; never descend into them. */
const BUNDLE = /\.(app|photoslibrary|framework|bundle|xcarchive|musiclibrary)$/i;

export interface FileIndexOptions {
  /** Stop indexing after this many entries (default 20,000). */
  maxEntries?: number;
  /** Stop after this long, in ms (default 1,500); the index is then marked partial. */
  timeBudgetMs?: number;
  maxDepth?: number;
  /** How long a finished index is reused, in ms (default 15,000). */
  cacheMs?: number;
  /** How long a suggestion waits for a running index before answering from what it has. */
  waitMs?: number;
}

export interface FileSuggestion {
  /** Path relative to the project, `/`-separated; folders end with `/`. */
  path: string;
  dir: boolean;
}

export interface FileSuggestions {
  entries: FileSuggestion[];
  /** More matches exist than were returned, or the index is still incomplete. */
  more: boolean;
}

interface Build {
  paths: string[];
  done: boolean;
  /** Stopped at a limit rather than walking everything. */
  partial: boolean;
  startedAt: number;
  promise: Promise<void>;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });

/**
 * Project files and folders for `@` completion. The index is built breadth-first in the
 * background (shallow paths first), respects the project's .gitignore, skips {@link NOISE_DIRS}
 * and stops at a size or time limit, so it stays quick even when run in a home folder.
 * Suggestions never wait long for it: an empty query and `folder/` queries read the folder
 * directly, and fuzzy queries use whatever has been indexed so far.
 */
export class FileIndex {
  private build: Build | undefined;
  private readonly opts: Required<FileIndexOptions>;

  constructor(
    private readonly cwd: string,
    opts: FileIndexOptions = {},
  ) {
    this.opts = {
      maxEntries: opts.maxEntries ?? 20_000,
      timeBudgetMs: opts.timeBudgetMs ?? 1500,
      maxDepth: opts.maxDepth ?? 12,
      cacheMs: opts.cacheMs ?? 15_000,
      waitMs: opts.waitMs ?? 150,
    };
  }

  /** Starts (or reuses) an index build. */
  private current(): Build {
    const b = this.build;
    if (b && (!b.done || Date.now() - b.startedAt < this.opts.cacheMs)) return b;
    const next: Build = {
      paths: b?.paths ?? [],
      done: false,
      partial: false,
      startedAt: Date.now(),
      promise: Promise.resolve(),
    };
    next.promise = this.walk(next).catch(() => {
      next.done = true;
      next.partial = true;
    });
    this.build = next;
    return next;
  }

  private async walk(b: Build): Promise<void> {
    const filter = await IgnoreFilter.load(this.cwd);
    const found: string[] = [];
    const deadline = Date.now() + this.opts.timeBudgetMs;
    let queue: { abs: string; rel: string; depth: number }[] = [
      { abs: this.cwd, rel: '', depth: 0 },
    ];
    let stopped = false;
    // breadth-first, one level at a time, reading a few folders in parallel
    while (queue.length > 0 && !stopped) {
      const next: typeof queue = [];
      for (let i = 0; i < queue.length && !stopped; i += 16) {
        const batch = queue.slice(i, i + 16);
        const listed = await Promise.all(
          batch.map(async (d) => ({
            d,
            entries: await fs.readdir(d.abs, { withFileTypes: true }).catch(() => []),
          })),
        );
        for (const { d, entries } of listed) {
          const sorted = entries.sort((a, c) => a.name.localeCompare(c.name));
          for (const e of sorted) {
            const abs = path.join(d.abs, e.name);
            const isDir = e.isDirectory();
            const rel = d.rel === '' ? e.name : `${d.rel}/${e.name}`;
            if ((isDir && NOISE_DIRS.has(e.name)) || e.name === '.DS_Store') continue;
            if (filter.ignores(abs, isDir)) continue;
            found.push(isDir ? `${rel}/` : rel);
            if (isDir && !BUNDLE.test(e.name) && d.depth + 1 < this.opts.maxDepth)
              next.push({ abs, rel, depth: d.depth + 1 });
            if (found.length >= this.opts.maxEntries) {
              stopped = true;
              break;
            }
          }
          if (stopped) break;
        }
        // publish progress so suggestions can use it while the walk goes on
        b.paths = found.slice();
        if (Date.now() > deadline) stopped = true;
      }
      queue = next;
    }
    b.paths = found;
    b.partial = stopped;
    b.done = true;
  }

  /** Resolves when the index that is building now has finished. */
  async ready(): Promise<void> {
    await this.current().promise;
  }

  /** Every indexed path (folders end with `/`), after the index has finished. */
  async list(): Promise<string[]> {
    const b = this.current();
    await b.promise;
    return b.paths;
  }

  /** Paths matching `query` (fuzzy), best first. */
  async search(query: string, limit = 8): Promise<string[]> {
    await this.ready();
    return rank(this.current().paths, query, limit).paths;
  }

  /**
   * Suggestions for `@query`, fast: an empty query lists the project's top level, `dir/…` lists
   * that folder's children, anything else is fuzzy-matched against the index (waiting at most
   * `waitMs` for a running build).
   */
  async suggest(query: string, limit = 10): Promise<FileSuggestions> {
    const slash = query.lastIndexOf('/');
    if (query === '' || slash >= 0) {
      const dirPart = slash >= 0 ? query.slice(0, slash + 1) : '';
      const listed = await this.children(dirPart, query.slice(slash + 1), limit);
      if (listed) return listed;
    }
    const b = this.current();
    if (!b.done) await Promise.race([b.promise, sleep(this.opts.waitMs)]);
    const { paths, more } = rank(b.paths, query, limit);
    return {
      entries: paths.map((p) => ({ path: p, dir: p.endsWith('/') })),
      more: more || !b.done || b.partial,
    };
  }

  /** Children of a folder inside the project, filtered by `rest`; undefined if not a folder. */
  private async children(
    dirPart: string,
    rest: string,
    limit: number,
  ): Promise<FileSuggestions | undefined> {
    if (dirPart.startsWith('/') || dirPart.startsWith('~') || dirPart.includes('..'))
      return undefined;
    const abs = path.join(this.cwd, dirPart);
    if (!isInside(abs, this.cwd)) return undefined;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return undefined;
    }
    const showHidden = rest.startsWith('.');
    const scored: { p: string; dir: boolean; s: number }[] = [];
    for (const e of entries) {
      if (e.name === '.git' || e.name === '.DS_Store') continue;
      if (!showHidden && e.name.startsWith('.')) continue;
      const s = rest === '' ? 0 : fuzzyScore(rest, e.name);
      if (s === undefined) continue;
      const dir = e.isDirectory();
      scored.push({ p: `${dirPart}${e.name}${dir ? '/' : ''}`, dir, s });
    }
    scored.sort(
      (a, b) =>
        b.s - a.s ||
        Number(b.dir) - Number(a.dir) ||
        a.p.localeCompare(b.p, undefined, { sensitivity: 'base' }),
    );
    return {
      entries: scored.slice(0, limit).map(({ p, dir }) => ({ path: p, dir })),
      more: scored.length > limit,
    };
  }
}

function rank(
  paths: readonly string[],
  query: string,
  limit: number,
): { paths: string[]; more: boolean } {
  const scored: { p: string; s: number }[] = [];
  const wantsHidden = query.includes('.');
  for (const p of paths) {
    const s = fuzzyScore(query, p);
    if (s === undefined) continue;
    // dotfiles and dot-folders rank below ordinary paths unless the query asks for a dot
    const hidden = !wantsHidden && /(^|\/)\./.test(p);
    scored.push({ p, s: hidden ? s - 8 : s });
  }
  scored.sort((a, b) => b.s - a.s || a.p.length - b.p.length || a.p.localeCompare(b.p));
  return { paths: scored.slice(0, limit).map((x) => x.p), more: scored.length > limit };
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
