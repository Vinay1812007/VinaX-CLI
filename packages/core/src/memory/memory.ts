import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { vinaxHome, type Env } from '../config/paths.js';
import { displayPath, isInside } from '../tools/paths.js';

export type MemoryScope = 'user' | 'project' | 'nested';

export interface MemoryFile {
  path: string;
  scope: MemoryScope;
  /** Content with `@imports` expanded. */
  content: string;
}

/** Instruction file names, in the order they are read within one folder. */
export const MEMORY_FILE_NAMES = ['VINAX.md', 'AGENTS.md'] as const;
const MAX_IMPORT_DEPTH = 4;
/** Memory is sent with every request; free tiers can't afford much (~2.5K tokens). */
const MAX_MEMORY_CHARS = 9000;

function readText(file: string): string | undefined {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 200_000) return undefined;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Inlines `@path/to/file` references (relative to the file that contains them, or `~/…`),
 * up to four levels deep. References inside code fences or inline code stay as written.
 */
export function expandImports(
  content: string,
  fromDir: string,
  depth = 0,
  seen: Set<string> = new Set(),
): string {
  if (depth >= MAX_IMPORT_DEPTH) return content;
  let inFence = false;
  return content
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
      if (inFence) return line;
      // split on inline code so `@x` inside backticks is left alone
      return line
        .split(/(`[^`]*`)/)
        .map((part) =>
          part.startsWith('`')
            ? part
            : part.replace(
                /(^|\s)@((?:~\/|\.{0,2}\/)?[\w./-]+\.[\w-]+)/g,
                (match, lead: string, ref: string) => {
                  const target = ref.startsWith('~/')
                    ? path.join(os.homedir(), ref.slice(2))
                    : path.resolve(fromDir, ref);
                  if (seen.has(target)) return match;
                  const text = readText(target);
                  if (text === undefined) return match;
                  const nested = expandImports(
                    text,
                    path.dirname(target),
                    depth + 1,
                    new Set([...seen, target]),
                  );
                  return `${lead}${nested.trim()}`;
                },
              ),
        )
        .join('');
    })
    .join('\n');
}

function findRepoRoot(cwd: string): string | undefined {
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    if (path.dirname(dir) === dir) return undefined;
  }
}

/**
 * Project instructions: `~/.vinax/VINAX.md`, then VINAX.md/AGENTS.md from the repository root
 * down to the working folder. Files in subfolders are picked up when VinaX first works there.
 */
export class ProjectMemory {
  private readonly checkedDirs = new Set<string>();

  private constructor(
    readonly cwd: string,
    readonly files: MemoryFile[],
    private readonly userFile: string,
  ) {}

  static load(cwd: string, env: Env = process.env): ProjectMemory {
    const files: MemoryFile[] = [];
    const userFile = path.join(vinaxHome(env), 'VINAX.md');
    const user = readText(userFile);
    if (user !== undefined)
      files.push({
        path: userFile,
        scope: 'user',
        content: expandImports(user, path.dirname(userFile)),
      });
    const root = findRepoRoot(cwd) ?? cwd;
    const chain: string[] = [];
    for (let dir = cwd; ; dir = path.dirname(dir)) {
      chain.unshift(dir);
      if (dir === root || path.dirname(dir) === dir) break;
    }
    const memory = new ProjectMemory(cwd, files, userFile);
    for (const dir of chain) {
      memory.checkedDirs.add(dir);
      for (const name of MEMORY_FILE_NAMES) {
        const file = path.join(dir, name);
        const text = readText(file);
        if (text !== undefined)
          files.push({ path: file, scope: 'project', content: expandImports(text, dir) });
      }
    }
    return memory;
  }

  /** Instruction files in folders between the project root and `file` that were not read yet. */
  discover(file: string): MemoryFile[] {
    if (!isInside(file, this.cwd)) return [];
    const found: MemoryFile[] = [];
    const dirs: string[] = [];
    for (
      let dir = path.dirname(file);
      isInside(dir, this.cwd) && !this.checkedDirs.has(dir);
      dir = path.dirname(dir)
    ) {
      dirs.unshift(dir);
    }
    for (const dir of dirs) {
      this.checkedDirs.add(dir);
      for (const name of MEMORY_FILE_NAMES) {
        const p = path.join(dir, name);
        const text = readText(p);
        if (text !== undefined)
          found.push({ path: p, scope: 'nested', content: expandImports(text, dir) });
      }
    }
    this.files.push(...found);
    return found;
  }

  /** User and project instructions for the system prompt (nested files go with tool results). */
  text(): string {
    const parts = this.files
      .filter((f) => f.scope !== 'nested')
      .map(
        (f) =>
          `## ${f.scope === 'user' ? '~/.vinax/VINAX.md (your personal notes)' : displayPath(f.path, this.cwd)}\n${f.content.trim()}`,
      );
    const all = parts.join('\n\n');
    return all.length <= MAX_MEMORY_CHARS
      ? all
      : `${all.slice(0, MAX_MEMORY_CHARS)}\n\n[… instructions truncated: keep VINAX.md files short]`;
  }

  /** Re-reads every known file (after editing them in $EDITOR) and picks up new ones. */
  reload(): void {
    const fresh = ProjectMemory.load(this.cwd, { VINAX_HOME: path.dirname(this.userFile) });
    const nested = this.files.filter((f) => f.scope === 'nested');
    this.files.length = 0;
    this.files.push(...fresh.files);
    for (const f of nested) {
      const text = readText(f.path);
      if (text !== undefined)
        this.files.push({ ...f, content: expandImports(text, path.dirname(f.path)) });
    }
  }

  noteTarget(scope: 'project' | 'user'): string {
    return scope === 'user' ? this.userFile : path.join(this.cwd, 'VINAX.md');
  }

  /** Appends a bullet to the chosen memory file (creating it) and reloads it. */
  async addNote(scope: 'project' | 'user', note: string): Promise<string> {
    const file = this.noteTarget(scope);
    let existing: string;
    try {
      existing = await fsp.readFile(file, 'utf8');
    } catch {
      existing = scope === 'user' ? '# My notes for VinaX\n\n' : '# Project instructions\n\n';
    }
    const sep = existing === '' || existing.endsWith('\n') ? '' : '\n';
    const next = `${existing}${sep}- ${note.trim()}\n`;
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, next, 'utf8');
    const content = expandImports(next, path.dirname(file));
    const current = this.files.find((f) => f.path === file);
    if (current) current.content = content;
    else this.files.push({ path: file, scope: scope === 'user' ? 'user' : 'project', content });
    return file;
  }
}
