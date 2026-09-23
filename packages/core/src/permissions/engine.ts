import path from 'node:path';
import type { PermissionMode } from '../config/schema.js';
import { displayPath, inWorkspace } from '../tools/paths.js';
import type { PermissionTarget, ToolKind } from '../tools/types.js';
import { detectDanger } from './danger.js';
import { parseRule, ruleMatches, type PermissionRule, type RuleEffect } from './rules.js';
import { splitCommands, type SimpleCommand } from './shell-parse.js';

export type Decision =
  | { kind: 'allow'; reason: string }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason: string; danger?: string; suggestion?: string };

export interface CallInfo {
  name: string;
  kind: ToolKind;
  readOnly: boolean;
  target: PermissionTarget;
}

export interface EngineOptions {
  rules: { allow: readonly string[]; ask: readonly string[]; deny: readonly string[] };
  cwd: string;
  workspace: readonly string[];
  /** The shell's current directory, which can move away from `cwd` via `cd`. */
  shellCwd: () => string;
  home?: string;
}

/** Commands whose rules are never auto-applied because they can hide other commands. */
function hasSubstitution(cmd: SimpleCommand): boolean {
  return cmd.text.includes('$(') || cmd.text.includes('`');
}

/** Programs whose second word is a subcommand worth keeping in a rule (`git push`, `npm test`). */
const SUBCOMMAND_TOOLS = new Set([
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'npx',
  'deno',
  'git',
  'cargo',
  'go',
  'docker',
  'kubectl',
  'pip',
  'pip3',
  'uv',
  'poetry',
  'make',
  'gradle',
  'mvn',
  'dotnet',
  'gh',
  'rustup',
  'brew',
  'apt',
  'terraform',
]);
/** Subcommands that take a further name (`npm run test`, `pnpm exec vitest`). */
const RUNNERS = new Set(['run', 'exec', 'x', 'run-script']);

/** `npm run test -- -u` → `Bash(npm run test:*)`, `pytest -x tests/` → `Bash(pytest:*)`. */
export function suggestBashRule(command: string): string | undefined {
  const cmds = splitCommands(command);
  if (cmds.length !== 1) return undefined;
  const words = (cmds[0]?.words ?? []).filter((w) => !w.startsWith('-'));
  const [program, sub, name] = words;
  if (program === undefined) return undefined;
  const prefix = [program];
  const plainWord = (w: string | undefined): w is string => w !== undefined && !/[/.=:]/.test(w);
  if (SUBCOMMAND_TOOLS.has(program) && plainWord(sub)) {
    prefix.push(sub);
    if (RUNNERS.has(sub) && plainWord(name)) prefix.push(name);
  }
  return `Bash(${prefix.join(' ')}:*)`;
}

/**
 * Decides whether a tool call runs, is refused, or needs the user's approval. Deny rules always
 * win; dangerous actions always ask; then ask rules, allow rules, and finally per-mode defaults.
 */
export class PermissionEngine {
  private readonly rules: PermissionRule[] = [];
  readonly invalidRules: string[] = [];

  constructor(private readonly opts: EngineOptions) {
    for (const effect of ['deny', 'ask', 'allow'] as const) {
      for (const raw of opts.rules[effect]) this.add(raw, effect, 'settings');
    }
  }

  private add(raw: string, effect: RuleEffect, source: string): void {
    const rule = parseRule(raw, effect, source);
    if (rule) this.rules.push(rule);
    else this.invalidRules.push(raw);
  }

  addSessionRule(raw: string, effect: RuleEffect = 'allow'): void {
    this.add(raw, effect, 'session');
  }

  private ctx() {
    return {
      cwd: this.opts.cwd,
      ...(this.opts.home === undefined ? {} : { home: this.opts.home }),
    };
  }

  private find(
    effect: RuleEffect,
    call: CallInfo,
    command?: SimpleCommand,
  ): PermissionRule | undefined {
    return this.rules.find((r) => r.effect === effect && ruleMatches(r, call, this.ctx(), command));
  }

  /** Bash: deny/ask if any part matches; allow only if every part matches an allow rule. */
  private match(effect: RuleEffect, call: CallInfo): PermissionRule | undefined {
    if (call.kind !== 'execute' || call.target.command === undefined)
      return this.find(effect, call);
    const plain = this.rules.find(
      (r) => r.effect === effect && r.specifier === undefined && ruleMatches(r, call, this.ctx()),
    );
    if (plain) return plain;
    const cmds = splitCommands(call.target.command);
    if (effect !== 'allow') {
      for (const c of cmds) {
        const hit = this.find(effect, call, c);
        if (hit) return hit;
      }
      return undefined;
    }
    if (cmds.length === 0 || cmds.some(hasSubstitution)) return undefined;
    const hits = cmds.map((c) => this.find('allow', call, c));
    return hits.every((h) => h !== undefined) ? hits[0] : undefined;
  }

  private suggestion(call: CallInfo): string | undefined {
    if (call.kind === 'execute' && call.target.command !== undefined)
      return suggestBashRule(call.target.command);
    if (call.target.domain !== undefined) return `${call.name}(domain:${call.target.domain})`;
    if (call.target.path !== undefined) {
      const dir = call.kind === 'read' ? call.target.path : path.dirname(call.target.path);
      const shown = displayPath(dir, this.opts.cwd);
      const spec = path.isAbsolute(shown) ? `/${shown}/**` : shown === '.' ? '**' : `${shown}/**`;
      return `${call.kind === 'edit' ? 'Edit' : 'Read'}(${spec})`;
    }
    return call.name.startsWith('mcp__') ? call.name : undefined;
  }

  decide(call: CallInfo, mode: PermissionMode): Decision {
    if (call.kind === 'meta') return { kind: 'allow', reason: 'VinaX internal tool' };
    if (mode === 'plan' && !call.readOnly) {
      return {
        kind: 'deny',
        reason:
          'Plan mode is on: only reading and searching are allowed until the plan is approved (call ExitPlanMode).',
      };
    }
    const deny = this.match('deny', call);
    if (deny) return { kind: 'deny', reason: `Blocked by the deny rule ${deny.raw}` };

    const suggestion = this.suggestion(call);
    const withSuggestion = suggestion === undefined ? {} : { suggestion };
    const danger = detectDanger(call.kind, call.target, {
      workspace: this.opts.workspace,
      shellCwd: this.opts.shellCwd(),
    });
    if (danger !== undefined) return { kind: 'ask', reason: `This ${danger}.`, danger };

    const ask = this.match('ask', call);
    if (ask)
      return {
        kind: 'ask',
        reason: `The ask rule ${ask.raw} requires approval.`,
        ...withSuggestion,
      };
    const allow = this.match('allow', call);
    if (allow) return { kind: 'allow', reason: `Allowed by ${allow.raw}` };

    const inside =
      call.target.path === undefined || inWorkspace(call.target.path, this.opts.workspace);
    switch (call.kind) {
      case 'read':
        return inside
          ? { kind: 'allow', reason: 'Reading inside the project' }
          : { kind: 'ask', reason: 'This reads outside the project folder.', ...withSuggestion };
      case 'edit':
        return mode === 'acceptEdits' && inside
          ? { kind: 'allow', reason: 'Auto-accepting edits' }
          : { kind: 'ask', reason: 'File changes need your approval.', ...withSuggestion };
      default:
        return { kind: 'ask', reason: 'Running commands needs your approval.', ...withSuggestion };
    }
  }
}
