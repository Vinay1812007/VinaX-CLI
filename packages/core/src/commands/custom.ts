import fs from 'node:fs/promises';
import path from 'node:path';
import { vinaxHome, type Env } from '../config/paths.js';
import { matchBashSpecifier, parseRule } from '../permissions/rules.js';
import { inWorkspace, resolvePath } from '../tools/paths.js';
import { truncateMiddle } from '../tools/truncate.js';

export interface CustomCommand {
  /** Slash name without the slash; subfolders become namespaces: `frontend:component`. */
  name: string;
  description: string;
  argumentHint: string | undefined;
  /** Permission rules allowed without asking while this command runs. */
  allowedTools: string[];
  model: string | undefined;
  body: string;
  file: string;
  scope: 'project' | 'user';
}

type FrontmatterValue = string | string[];

/** A small YAML subset: `key: value`, `key: [a, b]` and `- item` lists. */
export function parseFrontmatter(text: string): {
  data: Record<string, FrontmatterValue>;
  body: string;
} {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m?.[1]) return { data: {}, body: text };
  const data: Record<string, FrontmatterValue> = {};
  let listKey: string | undefined;
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '');
    if (line.trim() === '') continue;
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey !== undefined) {
      const list = data[listKey];
      if (Array.isArray(list)) list.push(unquote(item[1] ?? ''));
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv?.[1]) continue;
    const key = kv[1];
    const value = (kv[2] ?? '').trim();
    if (value === '') {
      data[key] = [];
      listKey = key;
    } else if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = value
        .slice(1, -1)
        .split(',')
        .map((v) => unquote(v.trim()))
        .filter((v) => v !== '');
      listKey = undefined;
    } else {
      data[key] = unquote(value);
      listKey = undefined;
    }
  }
  return { data, body: text.slice(m[0].length) };
}

function unquote(v: string): string {
  return /^(['"]).*\1$/.test(v) ? v.slice(1, -1) : v;
}

function asList(v: FrontmatterValue | undefined): string[] {
  if (v === undefined) return [];
  if (Array.isArray(v)) return v;
  // "Bash(git add:*), Read" — split on commas outside parentheses
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of v) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim() !== '') out.push(cur.trim());
  return out;
}

async function walk(
  dir: string,
  prefix: string[] = [],
): Promise<{ file: string; parts: string[] }[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: { file: string; parts: string[] }[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full, [...prefix, e.name])));
    else if (e.isFile() && e.name.endsWith('.md'))
      out.push({ file: full, parts: [...prefix, e.name.slice(0, -3)] });
  }
  return out;
}

const NAME_PART = /^[A-Za-z0-9_-]+$/;

/** Commands from `~/.vinax/commands/` and `.vinax/commands/`; project commands win on a clash. */
export async function loadCustomCommands(
  cwd: string,
  env: Env,
): Promise<{ commands: CustomCommand[]; errors: string[] }> {
  const errors: string[] = [];
  const byName = new Map<string, CustomCommand>();
  const sources = [
    { dir: path.join(vinaxHome(env), 'commands'), scope: 'user' as const },
    { dir: path.join(cwd, '.vinax', 'commands'), scope: 'project' as const },
  ];
  for (const { dir, scope } of sources) {
    for (const { file, parts } of await walk(dir)) {
      if (!parts.every((p) => NAME_PART.test(p))) {
        errors.push(`${file}: command names may only use letters, digits, - and _`);
        continue;
      }
      const text = await fs.readFile(file, 'utf8');
      const { data, body } = parseFrontmatter(text);
      const description =
        typeof data.description === 'string'
          ? data.description
          : (body.trim().split('\n')[0] ?? '').replace(/^#+\s*/, '').slice(0, 80);
      const name = parts.join(':');
      const model = typeof data.model === 'string' ? data.model : undefined;
      if (model !== undefined && !/^(groq|openrouter):\S+$/.test(model)) {
        errors.push(`${file}: model must look like "groq:openai/gpt-oss-120b"`);
      }
      const allowedTools = asList(data['allowed-tools']);
      for (const rule of allowedTools)
        if (!parseRule(rule, 'allow', file))
          errors.push(`${file}: malformed allowed-tools rule "${rule}"`);
      byName.set(name, {
        name,
        description: description === '' ? `Custom command (${scope})` : description,
        argumentHint: typeof data['argument-hint'] === 'string' ? data['argument-hint'] : undefined,
        allowedTools,
        model: model !== undefined && /^(groq|openrouter):\S+$/.test(model) ? model : undefined,
        body,
        file,
        scope,
      });
    }
  }
  return { commands: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), errors };
}

/** Shell-like argument split: `a "b c" 'd'` → ['a', 'b c', 'd']. */
export function splitArgs(args: string): string[] {
  const out: string[] = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
  for (const m of args.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

export interface ExpandContext {
  cwd: string;
  workspace: readonly string[];
  /** Runs a shell command for `!`cmd`` and returns its output. */
  runShell: (command: string) => Promise<string>;
}

/**
 * Builds the prompt for a custom command: `$ARGUMENTS` and `$1`…`$9` substitution, `!`cmd``
 * output (only for commands its `allowed-tools` permit) and `@file` contents.
 */
export async function expandCommand(
  cmd: CustomCommand,
  args: string,
  ctx: ExpandContext,
): Promise<{ prompt: string; warnings: string[] }> {
  const warnings: string[] = [];
  const positional = splitArgs(args);
  let text = cmd.body
    .replace(/\$ARGUMENTS/g, args.trim())
    .replace(/\$([1-9])/g, (_m, n: string) => positional[Number(n) - 1] ?? '');

  const bashRules = cmd.allowedTools
    .map((r) => parseRule(r, 'allow', cmd.file))
    .filter((r) => r?.tool === 'Bash')
    .map((r) => r?.specifier);
  const shellCalls = [...text.matchAll(/!`([^`]+)`/g)];
  for (const m of shellCalls) {
    const command = m[1] ?? '';
    const allowed = bashRules.some(
      (spec) => spec === undefined || matchBashSpecifier(spec, command),
    );
    let replacement: string;
    if (!allowed) {
      replacement = `[not run: add "allowed-tools: Bash(${command.split(/\s+/)[0] ?? command}:*)" to ${path.basename(cmd.file)} to allow it]`;
      warnings.push(`!\`${command}\` was not run: it is not in the command's allowed-tools.`);
    } else {
      replacement = truncateMiddle((await ctx.runShell(command)).trim(), 6000);
    }
    text = text.replace(m[0], () => replacement);
  }

  const mentions = [...text.matchAll(/(^|\s)@((?:~\/|\.{0,2}\/)?[\w./-]+)/g)];
  for (const m of mentions) {
    const ref = m[2] ?? '';
    const file = resolvePath(ref, ctx.cwd);
    if (!inWorkspace(file, ctx.workspace)) continue;
    const content = await fs.readFile(file, 'utf8').catch(() => undefined);
    if (content === undefined) continue;
    text = text.replace(
      `@${ref}`,
      () => `\n\`\`\`${ref}\n${truncateMiddle(content, 8000)}\n\`\`\`\n`,
    );
  }
  return { prompt: text.trim(), warnings };
}
