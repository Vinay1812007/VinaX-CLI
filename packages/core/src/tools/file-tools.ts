import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { diffDisplay, diffSummary } from './diff.js';
import { applyEdit, applyEdits, type EditSpec } from './edit-core.js';
import { displayPath, resolvePath } from './paths.js';
import { countLines, truncateMiddle } from './truncate.js';
import { defineTool, ToolError, type ToolContext, type ToolOutput } from './types.js';

const DEFAULT_READ_LINES = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

const filePath = z
  .string()
  .min(1)
  .describe('Path to the file: absolute, or relative to the project root');

async function readText(file: string): Promise<string> {
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    throw new ToolError(`File not found: ${file}`);
  }
  if (stat.isDirectory()) throw new ToolError(`${file} is a directory. Use LS to list it.`);
  if (stat.size > MAX_FILE_BYTES)
    throw new ToolError(
      `${file} is larger than 10 MB; read part of it with Bash (head/sed) instead.`,
    );
  const buf = await fs.readFile(file);
  if (buf.subarray(0, 8000).includes(0))
    throw new ToolError(`${file} looks like a binary file and cannot be shown as text.`);
  return buf.toString('utf8');
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function fail(message: string): ToolOutput {
  return { ok: false, content: message, summary: message.split('\n')[0] ?? message };
}

export const readTool = defineTool({
  name: 'Read',
  description:
    'Read a text file. Returns numbered lines ("   12\\tcode"). Reads up to 2000 lines; use offset and limit for longer files. Always Read a file before editing or overwriting it.',
  input: z.object({
    file_path: filePath,
    offset: z.number().int().min(1).optional().describe('1-based line number to start from'),
    limit: z.number().int().positive().optional().describe('Maximum number of lines to return'),
  }),
  kind: 'read',
  readOnly: true,
  label: (i) => i.file_path,
  target: (i, ctx) => ({ path: resolvePath(i.file_path, ctx.cwd) }),
  async run(i, ctx) {
    const file = resolvePath(i.file_path, ctx.cwd);
    const text = await readText(file);
    ctx.reads.record(file, text);
    if (text === '')
      return { ok: true, content: '(the file is empty)', summary: 'Read 0 lines (empty file)' };
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    if (lines.at(-1) === '') lines.pop();
    const start = (i.offset ?? 1) - 1;
    const end = Math.min(lines.length, start + (i.limit ?? DEFAULT_READ_LINES));
    if (start >= lines.length) {
      return fail(
        `offset ${String(start + 1)} is past the end of the file (${String(lines.length)} lines).`,
      );
    }
    const body = lines
      .slice(start, end)
      .map((line, n) => {
        const shown =
          line.length > MAX_LINE_CHARS
            ? `${line.slice(0, MAX_LINE_CHARS)}… [line truncated]`
            : line;
        return `${String(start + n + 1).padStart(6)}\t${shown}`;
      })
      .join('\n');
    const partial = start > 0 || end < lines.length;
    const note = partial
      ? `\n\n[Showing lines ${String(start + 1)}–${String(end)} of ${String(lines.length)}. Use offset/limit to read more.]`
      : '';
    return {
      ok: true,
      content: truncateMiddle(body + note, undefined, 'read a smaller range with offset/limit'),
      summary: `Read ${String(end - start)} line${end - start === 1 ? '' : 's'}${partial ? ` of ${String(lines.length)}` : ''}`,
    };
  },
});

async function writeWithDiff(
  ctx: ToolContext,
  file: string,
  before: string,
  after: string,
  created: boolean,
): Promise<ToolOutput> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, after, 'utf8');
  ctx.reads.record(file, after);
  const display = diffDisplay(displayPath(file, ctx.cwd), before, after, created);
  return {
    ok: true,
    content: created
      ? `Created ${displayPath(file, ctx.cwd)} (${String(countLines(after))} lines).`
      : `Updated ${displayPath(file, ctx.cwd)} (${diffSummary(display)} lines).`,
    summary: created
      ? `Created with ${String(countLines(after))} lines`
      : `Changed ${diffSummary(display)} lines`,
    display,
  };
}

export const writeTool = defineTool({
  name: 'Write',
  description:
    'Create a new file or completely replace an existing one. To change part of an existing file, prefer Edit. Overwriting requires reading the file first.',
  input: z.object({
    file_path: filePath,
    content: z.string().describe('The full new file content'),
  }),
  kind: 'edit',
  readOnly: false,
  label: (i) => i.file_path,
  target: (i, ctx) => ({ path: resolvePath(i.file_path, ctx.cwd) }),
  affectedPaths: (i, ctx) => [resolvePath(i.file_path, ctx.cwd)],
  async preview(i, ctx) {
    const file = resolvePath(i.file_path, ctx.cwd);
    const created = !(await exists(file));
    const before = created ? '' : await readText(file).catch(() => '');
    return diffDisplay(displayPath(file, ctx.cwd), before, i.content, created);
  },
  async run(i, ctx) {
    const file = resolvePath(i.file_path, ctx.cwd);
    const created = !(await exists(file));
    if (!created) {
      const stale = await ctx.reads.checkFresh(file);
      if (stale !== undefined) return fail(stale);
    }
    const before = created ? '' : await readText(file);
    return writeWithDiff(ctx, file, before, i.content, created);
  },
});

const editFields = {
  old_string: z.string().describe('Exact text to replace, including indentation'),
  new_string: z.string().describe('Replacement text'),
  replace_all: z
    .boolean()
    .optional()
    .describe('Replace every occurrence instead of requiring a unique match'),
};

async function editFile(
  ctx: ToolContext,
  fileArg: string,
  edits: readonly EditSpec[],
  dryRun: boolean,
): Promise<ToolOutput> {
  const file = resolvePath(fileArg, ctx.cwd);
  if (!dryRun) {
    const stale = await ctx.reads.checkFresh(file);
    if (stale !== undefined) return fail(stale);
  }
  const before = await readText(file);
  const result =
    edits.length === 1 && edits[0] ? applyEdit(before, edits[0]) : applyEdits(before, edits);
  if (!result.ok) return fail(result.error);
  if (dryRun) {
    const display = diffDisplay(displayPath(file, ctx.cwd), before, result.content, false);
    return { ok: true, content: '', summary: '', display };
  }
  return writeWithDiff(ctx, file, before, result.content, false);
}

export const editTool = defineTool({
  name: 'Edit',
  description:
    'Replace an exact string in a file. old_string must appear exactly once (include enough surrounding lines to be unique) unless replace_all is true. You must Read the file first; the edit is refused if the file changed since.',
  input: z.object({ file_path: filePath, ...editFields }),
  kind: 'edit',
  readOnly: false,
  label: (i) => i.file_path,
  target: (i, ctx) => ({ path: resolvePath(i.file_path, ctx.cwd) }),
  affectedPaths: (i, ctx) => [resolvePath(i.file_path, ctx.cwd)],
  preview: async (i, ctx) => (await editFile(ctx, i.file_path, [i], true)).display,
  run: (i, ctx) => editFile(ctx, i.file_path, [i], false),
});

export const multiEditTool = defineTool({
  name: 'MultiEdit',
  description:
    'Apply several exact-string edits to one file in order, atomically: if any edit fails, none are applied. Same rules as Edit for each edit.',
  input: z.object({ file_path: filePath, edits: z.array(z.object(editFields)).min(1) }),
  kind: 'edit',
  readOnly: false,
  label: (i) => `${i.file_path} (${String(i.edits.length)} edits)`,
  target: (i, ctx) => ({ path: resolvePath(i.file_path, ctx.cwd) }),
  affectedPaths: (i, ctx) => [resolvePath(i.file_path, ctx.cwd)],
  preview: async (i, ctx) => (await editFile(ctx, i.file_path, i.edits, true)).display,
  run: (i, ctx) => editFile(ctx, i.file_path, i.edits, false),
});
