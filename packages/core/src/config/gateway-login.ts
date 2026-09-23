import { updateSettingsFile } from './load.js';
import type { Env } from './paths.js';
import { openSecretStore, type SecretSource } from './secrets.js';

/** Stores the gateway URL in user settings and its token with the other secrets. */
export async function saveGatewayLogin(
  url: string,
  token: string,
  opts: { cwd: string; env: Env },
): Promise<SecretSource> {
  const clean = url.replace(/\/+$/, '');
  await updateSettingsFile({ ...opts, scope: 'user' }, (s) => ({
    ...s,
    gateway: {
      ...(typeof s.gateway === 'object' && s.gateway !== null ? s.gateway : {}),
      url: clean,
    },
  }));
  return (await openSecretStore(opts.env)).set('gateway', token);
}

/** Forgets the gateway: removes its URL from user settings and deletes the stored token. */
export async function removeGatewayLogin(opts: { cwd: string; env: Env }): Promise<boolean> {
  const seen = { gateway: false };
  await updateSettingsFile({ ...opts, scope: 'user' }, (s) => {
    if (typeof s.gateway !== 'object' || s.gateway === null) return s;
    seen.gateway = true;
    const rest = Object.fromEntries(
      Object.entries(s.gateway as Record<string, unknown>).filter(([k]) => k !== 'url'),
    );
    const next = Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'gateway'));
    return Object.keys(rest).length === 0 ? next : { ...next, gateway: rest };
  });
  const removed = await (await openSecretStore(opts.env)).delete('gateway');
  return seen.gateway || removed;
}
