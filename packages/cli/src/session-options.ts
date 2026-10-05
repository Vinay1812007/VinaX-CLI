import type { PermissionMode, Settings } from '@vinax/core';

/** Command-line options shared by interactive and print mode. */
export interface SessionOptions {
  prompt: string | undefined;
  model: string | undefined;
  verbose: boolean;
  permissionMode: PermissionMode | undefined;
  allowedTools: string[];
  disallowedTools: string[];
  addDirs: string[];
  maxTurns: number | undefined;
  /** Per-task limits (`--token-budget`, `--time-budget` seconds). */
  tokenBudget?: number | undefined;
  timeBudget?: number | undefined;
  /** `-c`: continue the most recent session in this folder. */
  continueLast: boolean;
  /** `-r`: `true` shows a picker; a string resumes that session id. */
  resume: boolean | string | undefined;
  /** Shown when the session starts (e.g. that it runs in a worktree). */
  notices?: string[];
  /** Set when running in a VinaX worktree (`--worktree`). */
  worktree?: string | undefined;
}

/** The highest-precedence settings layer, built from command-line flags. */
export function cliSettings(o: SessionOptions): Settings | undefined {
  const permissions = {
    ...(o.allowedTools.length === 0 ? {} : { allow: o.allowedTools }),
    ...(o.disallowedTools.length === 0 ? {} : { deny: o.disallowedTools }),
    ...(o.addDirs.length === 0 ? {} : { additionalDirectories: o.addDirs }),
    ...(o.permissionMode === undefined ? {} : { defaultMode: o.permissionMode }),
  };
  const budget = {
    ...(o.tokenBudget === undefined ? {} : { tokens: o.tokenBudget }),
    ...(o.timeBudget === undefined ? {} : { seconds: o.timeBudget }),
  };
  const settings: Settings = {
    ...(o.model === undefined ? {} : { model: o.model }),
    ...(Object.keys(permissions).length === 0 ? {} : { permissions }),
    ...(Object.keys(budget).length === 0 ? {} : { budget }),
  };
  return Object.keys(settings).length === 0 ? undefined : settings;
}
