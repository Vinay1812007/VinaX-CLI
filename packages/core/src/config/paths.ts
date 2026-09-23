import os from 'node:os';
import path from 'node:path';

export type Env = Readonly<Record<string, string | undefined>>;

/** Root of VinaX's per-user state. `VINAX_HOME` overrides it (used by tests and portable installs). */
export function vinaxHome(env: Env = process.env): string {
  const override = env.VINAX_HOME;
  return override !== undefined && override !== ''
    ? path.resolve(override)
    : path.join(os.homedir(), '.vinax');
}

export interface SettingsPaths {
  user: string;
  project: string;
  local: string;
}

export function settingsPaths(cwd: string, env: Env = process.env): SettingsPaths {
  const projectDir = path.join(cwd, '.vinax');
  return {
    user: path.join(vinaxHome(env), 'settings.json'),
    project: path.join(projectDir, 'settings.json'),
    local: path.join(projectDir, 'settings.local.json'),
  };
}

export function cacheDir(env: Env = process.env): string {
  return path.join(vinaxHome(env), 'cache');
}

export function logDir(env: Env = process.env): string {
  return path.join(vinaxHome(env), 'logs');
}
