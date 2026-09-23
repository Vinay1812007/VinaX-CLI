import { inWorkspace, resolvePath } from '../tools/paths.js';
import type { PermissionTarget, ToolKind } from '../tools/types.js';
import { splitCommands, type SimpleCommand } from './shell-parse.js';

export interface DangerContext {
  workspace: readonly string[];
  /** Where relative paths in shell commands resolve (the shell's current directory). */
  shellCwd: string;
}

const SAFE_SINKS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', 'NUL', 'nul']);
const SHELLS = /^(sudo\s+)?(sh|bash|zsh|dash|ksh|fish|python3?|node|perl|ruby)\b/;

function flags(cmd: SimpleCommand): Set<string> {
  const set = new Set<string>();
  for (const w of cmd.words.slice(1)) {
    if (w.startsWith('--')) set.add(w);
    else if (w.startsWith('-')) for (const ch of w.slice(1)) set.add(`-${ch}`);
  }
  return set;
}

function commandDanger(cmd: SimpleCommand, ctx: DangerContext): string | undefined {
  const [name = '', sub = ''] = cmd.words;
  const f = flags(cmd);
  if (name === 'sudo' || name === 'doas') return 'runs with administrator rights';
  if (name === 'rm') {
    const recursive = f.has('-r') || f.has('-R') || f.has('--recursive');
    const force = f.has('-f') || f.has('--force');
    const targets = cmd.words.slice(1).filter((w) => !w.startsWith('-'));
    if (targets.some((t) => t === '/' || t === '~' || t === '*' || t === '.' || t === '..')) {
      return 'deletes a whole folder tree (/, ~, . or *)';
    }
    if (targets.some((t) => !inWorkspace(resolvePath(t, ctx.shellCwd), ctx.workspace))) {
      return 'deletes files outside the project folder';
    }
    if (recursive && force) return 'deletes files recursively without confirmation (rm -rf)';
    if (recursive) return 'deletes folders recursively';
  }
  if (name === 'git') {
    if (
      sub === 'push' &&
      (f.has('-f') ||
        f.has('--force') ||
        f.has('--force-with-lease') ||
        cmd.words.some((w) => w.startsWith('+')))
    ) {
      return 'force-pushes, which can overwrite history on the remote';
    }
    if (sub === 'reset' && f.has('--hard'))
      return 'discards uncommitted changes (git reset --hard)';
    if (sub === 'clean' && (f.has('-f') || f.has('--force')))
      return 'deletes untracked files (git clean)';
    if (
      (sub === 'checkout' || sub === 'restore') &&
      cmd.words.includes('.') &&
      !f.has('--staged')
    ) {
      return 'discards uncommitted changes to every file';
    }
    if (sub === 'branch' && f.has('-D')) return 'force-deletes a branch';
  }
  if (name === 'mkfs' || name.startsWith('mkfs.') || name === 'fdisk' || name === 'diskutil')
    return 'can erase a disk';
  if (name === 'dd' && cmd.words.some((w) => w.startsWith('of=/dev/')))
    return 'writes directly to a device';
  if (name === 'chmod' && (f.has('-R') || f.has('--recursive')) && cmd.words.includes('777')) {
    return 'makes files world-writable recursively';
  }
  if (['shutdown', 'reboot', 'halt', 'poweroff'].includes(name))
    return 'shuts down or restarts the machine';
  for (const target of cmd.redirects) {
    if (SAFE_SINKS.has(target)) continue;
    if (target.startsWith('/dev/')) return 'writes directly to a device';
    if (!inWorkspace(resolvePath(target, ctx.shellCwd), ctx.workspace))
      return 'writes to a file outside the project folder';
  }
  return undefined;
}

/**
 * Actions that always need explicit approval, whatever the mode or allow rules say.
 * Returns a short reason for the approval prompt, or `undefined`.
 */
export function detectDanger(
  kind: ToolKind,
  target: PermissionTarget,
  ctx: DangerContext,
): string | undefined {
  if (kind === 'edit' && target.path !== undefined && !inWorkspace(target.path, ctx.workspace)) {
    return 'changes a file outside the project folder';
  }
  if (kind !== 'execute' || target.command === undefined) return undefined;
  const command = target.command;
  if (/\b(curl|wget|iwr|Invoke-WebRequest)\b[^|]*\|\s*/.test(command)) {
    const piped = command
      .split('|')
      .slice(1)
      .map((s) => s.trim());
    if (piped.some((s) => SHELLS.test(s))) return 'runs a script downloaded from the internet';
  }
  if (/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(command)) return 'is a fork bomb';
  for (const cmd of splitCommands(command)) {
    const reason = commandDanger(cmd, ctx);
    if (reason !== undefined) return reason;
  }
  return undefined;
}
