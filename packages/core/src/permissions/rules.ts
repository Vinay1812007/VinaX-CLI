import os from 'node:os';
import path from 'node:path';
import picomatch from 'picomatch';
import { toPosix } from '../tools/paths.js';
import type { PermissionTarget, ToolKind } from '../tools/types.js';
import type { SimpleCommand } from './shell-parse.js';

export type RuleEffect = 'allow' | 'ask' | 'deny';

export interface PermissionRule {
  effect: RuleEffect;
  /** Tool name, `Edit`/`Read` group name, or an MCP pattern like `mcp__github__*`. */
  tool: string;
  specifier: string | undefined;
  /** The rule as written, for messages. */
  raw: string;
  source: string;
}

export interface RuleContext {
  cwd: string;
  home?: string;
}

/** Parses `Tool` or `Tool(specifier)`. Returns `undefined` for malformed rules. */
export function parseRule(
  raw: string,
  effect: RuleEffect,
  source: string,
): PermissionRule | undefined {
  const m = /^\s*([A-Za-z0-9_*-]+)\s*(?:\((.*)\))?\s*$/s.exec(raw);
  if (!m?.[1]) return undefined;
  const specifier = m[2]?.trim();
  return {
    effect,
    tool: m[1],
    specifier: specifier === '' ? undefined : specifier,
    raw: raw.trim(),
    source,
  };
}

/** Does the rule name this tool? `Edit` covers every file-changing tool, `Read` every read tool. */
export function ruleCoversTool(rule: PermissionRule, name: string, kind: ToolKind): boolean {
  if (rule.tool === name) return true;
  if (rule.tool === 'Edit') return kind === 'edit';
  if (rule.tool === 'Read') return kind === 'read';
  if (rule.tool.startsWith('mcp__')) {
    if (rule.tool.endsWith('*')) return name.startsWith(rule.tool.slice(0, -1));
    return name.startsWith(`${rule.tool}__`);
  }
  return false;
}

function escapeRegex(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Matches one simple command against a Bash rule specifier:
 * - `npm run test:*` — prefix match on a word boundary (`npm run test`, `npm run test -- -u`)
 * - `git log *` — `*` wildcards; a trailing ` *` also matches the bare command (`git log`)
 * - anything else — exact match
 */
export function matchBashSpecifier(spec: string, command: string): boolean {
  const text = command.trim().replace(/\s+/g, ' ');
  if (spec.endsWith(':*')) {
    const prefix = spec.slice(0, -2).trim();
    return text === prefix || text.startsWith(`${prefix} `);
  }
  if (spec.includes('*')) {
    const pattern = spec.split('*').map(escapeRegex).join('.*');
    if (new RegExp(`^${pattern}$`, 's').test(text)) return true;
    return spec.endsWith(' *') && text === spec.slice(0, -2).trim();
  }
  return text === spec.trim();
}

/**
 * Path specifiers, gitignore-style:
 * `//abs/path` absolute · `~/x` home · `/x` or `./x` or `x/y` relative to the project root ·
 * a pattern without a slash (`*.env`, `.env`) matches that name at any depth.
 */
export function pathSpecifierToGlob(spec: string, ctx: RuleContext): string {
  const home = toPosix(path.resolve(ctx.home ?? os.homedir()));
  // `//path` is absolute; on Windows it gets the current drive, like any other absolute path
  if (spec.startsWith('//')) return toPosix(path.resolve(spec.slice(1)));
  if (spec.startsWith('~/')) return `${home}/${spec.slice(2)}`;
  const root = toPosix(path.resolve(ctx.cwd));
  if (spec.startsWith('/')) return `${root}${spec}`;
  if (spec.startsWith('./')) return `${root}/${spec.slice(2)}`;
  if (!spec.includes('/')) return `${root}/**/${spec}`;
  return `${root}/${spec}`;
}

export function matchPathSpecifier(spec: string, file: string, ctx: RuleContext): boolean {
  const glob = pathSpecifierToGlob(spec, ctx);
  const target = toPosix(path.resolve(file));
  // Windows paths are case-insensitive (C:\ vs c:\)
  const isMatch = picomatch(glob, { dot: true, nocase: process.platform === 'win32' });
  // "src/**" should also cover the folder "src" itself
  return isMatch(target) || (glob.endsWith('/**') && target === glob.slice(0, -3));
}

export function matchDomain(spec: string, domain: string): boolean {
  const want = spec.replace(/^domain:/, '').toLowerCase();
  const host = domain.toLowerCase();
  return want === '*' || host === want || host.endsWith(`.${want}`);
}

/**
 * Does the rule match this call? For Bash, `commands` are the call's simple commands and the
 * rule must match `command` (one of them). A rule without a specifier matches every call.
 */
export function ruleMatches(
  rule: PermissionRule,
  call: { name: string; kind: ToolKind; target: PermissionTarget },
  ctx: RuleContext,
  command?: SimpleCommand,
): boolean {
  if (!ruleCoversTool(rule, call.name, call.kind)) return false;
  const spec = rule.specifier;
  if (spec === undefined || spec === '*') return true;
  if (command !== undefined) return matchBashSpecifier(spec, command.text);
  if (call.target.domain !== undefined && spec.startsWith('domain:'))
    return matchDomain(spec, call.target.domain);
  if (call.target.path !== undefined) return matchPathSpecifier(spec, call.target.path, ctx);
  return false;
}
