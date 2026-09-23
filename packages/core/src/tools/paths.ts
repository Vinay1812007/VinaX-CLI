import os from 'node:os';
import path from 'node:path';

/** Resolves a user/model supplied path: `~` expands, relative paths are taken from `cwd`. */
export function resolvePath(p: string, cwd: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return path.resolve(cwd, p);
}

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function inWorkspace(p: string, workspace: readonly string[]): boolean {
  return workspace.some((dir) => isInside(p, dir));
}

/** Forward-slash path relative to `cwd` when inside it, otherwise absolute — for display and rules. */
export function displayPath(p: string, cwd: string): string {
  const rel = path.relative(cwd, p);
  const shown = rel === '' ? '.' : rel.startsWith('..') || path.isAbsolute(rel) ? p : rel;
  return shown.split(path.sep).join('/');
}

/** POSIX form of an absolute path, used for glob matching on every platform. */
export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}
