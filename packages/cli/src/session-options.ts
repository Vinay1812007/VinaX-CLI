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
  /** `-c`: continue the most recent session in this folder. */
  continueLast: boolean;
  /** `-r`: `true` shows a picker; a string resumes that session id. */
  resume: boolean | string | undefined;
}

/** The highest-precedence settings layer, built from command-line flags. */
export function cliSettings(o: SessionOptions): Settings | undefined {
  const permissions = {
    ...(o.allowedTools.length === 0 ? {} : { allow: o.allowedTools }),
    ...(o.disallowedTools.length === 0 ? {} : { deny: o.disallowedTools }),
    ...(o.addDirs.length === 0 ? {} : { additionalDirectories: o.addDirs }),
    ...(o.permissionMode === undefined ? {} : { defaultMode: o.permissionMode }),
  };
  const settings: Settings = {
    ...(o.model === undefined ? {} : { model: o.model }),
    ...(Object.keys(permissions).length === 0 ? {} : { permissions }),
  };
  return Object.keys(settings).length === 0 ? undefined : settings;
}
