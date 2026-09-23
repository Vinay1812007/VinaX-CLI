import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import picomatch from 'picomatch';
import { z } from 'zod';
import { IgnoreFilter } from './ignore-filter.js';
import { displayPath, resolvePath } from './paths.js';
import { truncateMiddle } from './truncate.js';
import { defineTool, ToolError } from './types.js';

const MAX_GLOB_RESULTS = 200;
const MAX_LS_ENTRIES = 300;

async function dirOf(p: string | undefined, cwd: string): Promise<string> {
  const dir = resolvePath(p ?? '.', cwd);
  const stat = await fs.stat(dir).catch(() => undefined);
  if (!stat) throw new ToolError(`Path not found: ${dir}`);
  return dir;
}

export const globTool = defineTool({
  name: 'Glob',
  description:
    'Find files by glob pattern, e.g. "**/*.ts" or "src/**/test_*.py". Respects .gitignore. Returns paths sorted by most recently modified.',
  input: z.object({
    pattern: z.string().min(1).describe('Glob pattern'),
    path: z.string().optional().describe('Folder to search in (default: project root)'),
  }),
  kind: 'read',
  readOnly: true,
  label: (i) => (i.path === undefined ? i.pattern : `${i.pattern} in ${i.path}`),
  target: (i, ctx) => ({ path: resolvePath(i.path ?? '.', ctx.cwd) }),
  async run(i, ctx) {
    const base = await dirOf(i.path, ctx.cwd);
    const filter = await IgnoreFilter.load(ctx.cwd);
    const entries = await fg(i.pattern, {
      cwd: base,
      absolute: true,
      dot: true,
      onlyFiles: true,
      followSymbolicLinks: false,
      stats: true,
      ignore: ['**/.git/**', '**/node_modules/**'],
    });
    const files = entries
      .filter((e) => !filter.ignores(e.path))
      .sort((a, b) => (b.stats?.mtimeMs ?? 0) - (a.stats?.mtimeMs ?? 0));
    if (files.length === 0)
      return { ok: true, content: 'No files matched.', summary: 'Found 0 files' };
    const shown = files.slice(0, MAX_GLOB_RESULTS).map((f) => displayPath(f.path, ctx.cwd));
    const more =
      files.length > MAX_GLOB_RESULTS
        ? `\n[${String(files.length - MAX_GLOB_RESULTS)} more — narrow the pattern]`
        : '';
    return {
      ok: true,
      content: shown.join('\n') + more,
      summary: `Found ${String(files.length)} file${files.length === 1 ? '' : 's'}`,
    };
  },
});

const grepInput = z.object({
  pattern: z.string().min(1).describe('Regular expression (ripgrep syntax)'),
  path: z.string().optional().describe('File or folder to search (default: project root)'),
  glob: z.string().optional().describe('Only search files matching this glob, e.g. "*.ts"'),
  type: z.string().optional().describe('Only search this file type, e.g. "js", "py", "rust"'),
  output_mode: z
    .enum(['content', 'files_with_matches', 'count'])
    .optional()
    .describe(
      'content: matching lines; files_with_matches (default): file paths; count: matches per file',
    ),
  case_insensitive: z.boolean().optional(),
  context: z
    .number()
    .int()
    .min(0)
    .max(20)
    .optional()
    .describe('Lines of context around each match (content mode)'),
  multiline: z.boolean().optional().describe('Let . and patterns span lines'),
  head_limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Return only the first N lines of output'),
});
type GrepInput = z.infer<typeof grepInput>;

let rgBinary: Promise<string | undefined> | undefined;

/** Bundled @vscode/ripgrep, then `rg` on PATH; `undefined` means use the JS fallback. */
function findRipgrep(): Promise<string | undefined> {
  rgBinary ??= (async () => {
    try {
      const mod = (await import('@vscode/ripgrep')) as { rgPath: string };
      await fs.access(mod.rgPath);
      return mod.rgPath;
    } catch {
      return new Promise<string | undefined>((resolve) => {
        execFile('rg', ['--version'], (err) => {
          resolve(err ? undefined : 'rg');
        });
      });
    }
  })();
  return rgBinary;
}

function ripgrep(
  bin: string,
  i: GrepInput,
  cwd: string,
  target: string,
  signal: AbortSignal,
): Promise<string> {
  const mode = i.output_mode ?? 'files_with_matches';
  const args = [
    '--color=never',
    '--hidden',
    '--glob',
    '!.git',
    '--no-require-git',
    '--max-columns',
    '400',
    '--sort=path',
  ];
  if (mode === 'files_with_matches') args.push('-l');
  else if (mode === 'count') args.push('-c', '--with-filename');
  else
    args.push(
      '-n',
      '--with-filename',
      ...(i.context === undefined ? [] : ['-C', String(i.context)]),
    );
  if (i.case_insensitive === true) args.push('-i');
  if (i.multiline === true) args.push('-U', '--multiline-dotall');
  if (i.glob !== undefined) args.push('--glob', i.glob);
  if (i.type !== undefined) args.push('--type', i.type);
  // Always pass a path: without one, rg reads stdin when it is not a terminal.
  args.push('-e', i.pattern, '--', path.relative(cwd, target) || '.');
  return new Promise((resolve, reject) => {
    execFile(bin, args, { cwd, signal, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = (err as { code?: unknown } | null)?.code;
      if (err && code === 1) resolve('');
      else if (err) reject(new ToolError(stderr.trim() === '' ? err.message : stderr.trim()));
      else resolve(stdout.replace(/^\.[\\/]/gm, ''));
    });
  });
}

const TYPE_GLOBS: Record<string, string> = {
  js: '*.{js,jsx,mjs,cjs}',
  ts: '*.{ts,tsx,mts,cts}',
  py: '*.py',
  rust: '*.rs',
  go: '*.go',
  java: '*.java',
  md: '*.{md,markdown}',
  json: '*.json',
};

/** Pure-JS search for machines without ripgrep. Same output shape, fewer features. */
async function jsGrep(i: GrepInput, cwd: string, target: string): Promise<string> {
  const mode = i.output_mode ?? 'files_with_matches';
  const re = new RegExp(
    i.pattern,
    `${i.case_insensitive === true ? 'i' : ''}${i.multiline === true ? 's' : ''}`,
  );
  const filter = await IgnoreFilter.load(cwd);
  const stat = await fs.stat(target);
  const files = stat.isFile()
    ? [target]
    : await fg('**/*', {
        cwd: target,
        absolute: true,
        dot: true,
        onlyFiles: true,
        ignore: ['**/.git/**', '**/node_modules/**'],
      });
  const globs = [i.glob, i.type === undefined ? undefined : TYPE_GLOBS[i.type]].filter(
    (g): g is string => g !== undefined,
  );
  const matchers = globs.map((g) => picomatch(g, { basename: !g.includes('/'), dot: true }));
  const out: string[] = [];
  for (const file of files.sort()) {
    if (filter.ignores(file)) continue;
    const rel = displayPath(file, cwd);
    if (!matchers.every((m) => m(rel))) continue;
    const buf = await fs.readFile(file).catch(() => undefined);
    if (!buf || buf.length > 2_000_000 || buf.subarray(0, 8000).includes(0)) continue;
    const lines = buf.toString('utf8').split('\n');
    const hits = lines.map((l, n) => (re.test(l) ? n : -1)).filter((n) => n >= 0);
    if (hits.length === 0) continue;
    if (mode === 'files_with_matches') out.push(rel);
    else if (mode === 'count') out.push(`${rel}:${String(hits.length)}`);
    else for (const n of hits) out.push(`${rel}:${String(n + 1)}:${lines[n] ?? ''}`);
  }
  return out.join('\n');
}

export const grepTool = defineTool({
  name: 'Grep',
  description:
    'Search file contents with a regular expression (ripgrep). Respects .gitignore. Use output_mode "content" to see matching lines with line numbers; the default lists matching files.',
  input: grepInput,
  kind: 'read',
  readOnly: true,
  label: (i) => (i.path === undefined ? `"${i.pattern}"` : `"${i.pattern}" in ${i.path}`),
  target: (i, ctx) => ({ path: resolvePath(i.path ?? '.', ctx.cwd) }),
  async run(i, ctx) {
    const target = resolvePath(i.path ?? '.', ctx.cwd);
    await fs.stat(target).catch(() => {
      throw new ToolError(`Path not found: ${target}`);
    });
    const bin = await findRipgrep();
    const raw =
      bin === undefined
        ? await jsGrep(i, ctx.cwd, target)
        : await ripgrep(bin, i, ctx.cwd, target, ctx.signal);
    let lines = raw.split('\n').filter((l) => l !== '');
    const total = lines.length;
    if (i.head_limit !== undefined) lines = lines.slice(0, i.head_limit);
    if (total === 0) return { ok: true, content: 'No matches found.', summary: 'No matches' };
    const mode = i.output_mode ?? 'files_with_matches';
    const noun = mode === 'content' ? 'line' : 'file';
    const more =
      lines.length < total ? `\n[${String(total - lines.length)} more lines not shown]` : '';
    return {
      ok: true,
      content: truncateMiddle(
        lines.join('\n') + more,
        undefined,
        'narrow the pattern, path or glob',
      ),
      summary: `Found ${String(total)} ${noun}${total === 1 ? '' : 's'}`,
    };
  },
});

export const lsTool = defineTool({
  name: 'LS',
  description:
    'List a folder as a tree (two levels deep). Folders end with "/". Respects .gitignore.',
  input: z.object({
    path: z.string().optional().describe('Folder to list (default: project root)'),
    ignore: z.array(z.string()).optional().describe('Extra glob patterns to leave out'),
  }),
  kind: 'read',
  readOnly: true,
  label: (i) => i.path ?? '.',
  target: (i, ctx) => ({ path: resolvePath(i.path ?? '.', ctx.cwd) }),
  async run(i, ctx) {
    const root = await dirOf(i.path, ctx.cwd);
    const filter = await IgnoreFilter.load(ctx.cwd);
    const extra = (i.ignore ?? []).map((g) => picomatch(g, { basename: true, dot: true }));
    const out: string[] = [];
    let count = 0;
    const walk = async (dir: string, depth: number): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      entries.sort(
        (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
      );
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (filter.ignores(full, e.isDirectory()) || extra.some((m) => m(e.name))) continue;
        if (++count > MAX_LS_ENTRIES) return;
        out.push(`${'  '.repeat(depth)}${e.name}${e.isDirectory() ? '/' : ''}`);
        if (e.isDirectory() && depth < 1) await walk(full, depth + 1);
      }
    };
    await walk(root, 0);
    const more = count > MAX_LS_ENTRIES ? `\n[more entries not shown — list a subfolder]` : '';
    return {
      ok: true,
      content: `${displayPath(root, ctx.cwd)}/\n${out.map((l) => `  ${l}`).join('\n')}${more}`,
      summary: `Listed ${String(Math.min(count, MAX_LS_ENTRIES))} entries`,
    };
  },
});
