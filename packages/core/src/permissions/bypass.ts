import type { Env } from '../config/paths.js';

/** Set to 1 to allow bypass mode as root (for example inside a throwaway container). */
export const ALLOW_ROOT_BYPASS_ENV = 'VINAX_ALLOW_ROOT_BYPASS';

/** Shown whenever a session runs in bypass mode. */
export const BYPASS_WARNING =
  'Bypass mode is on: VinaX runs every edit, command and web request without asking — dangerous ones included. Only deny rules still block. Use it only in a disposable environment.';

/**
 * Why bypass mode is refused here, or `undefined` when it may run. As root a bad command can
 * damage the whole machine, so it needs an explicit opt-in.
 */
export function bypassRefusal(
  env: Env = process.env,
  uid: number | undefined = process.getuid?.(),
): string | undefined {
  if (uid !== 0) return undefined;
  if (env[ALLOW_ROOT_BYPASS_ENV] === '1') return undefined;
  return `Bypass mode is refused when running as root. Run VinaX as a normal user, or set ${ALLOW_ROOT_BYPASS_ENV}=1 if this is a disposable container.`;
}
