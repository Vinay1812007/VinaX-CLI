import { Command } from 'commander';
import {
  checkGateway,
  GATEWAY_WAKING,
  gatewayUrlProblem,
  loadSettings,
  openSecretStore,
  PROVIDER_NAMES,
  providerLabel,
  removeGatewayLogin,
  saveGatewayLogin,
  SECRET_ENV_VARS,
} from '@vinax/core';
import { storeProviderKey } from './config-command.js';
import { EXIT } from './exit-codes.js';
import { paint, readSecret, type CliIO } from './io.js';

const PROVIDERS = PROVIDER_NAMES.join('|');

export function loginCommand(io: CliIO, setExit: (code: number) => void): Command {
  const out = (s: string) => io.stdout.write(`${s}\n`);
  const err = (s: string) => io.stderr.write(`${s}\n`);
  return new Command('login')
    .description(
      `Store a provider API key (${PROVIDERS}), or connect to a VinaX gateway with --gateway <url>`,
    )
    .argument('[provider]', PROVIDERS)
    .option('--gateway <url>', 'use a VinaX gateway for providers you have no key for')
    .option('--no-verify', 'store without checking it live')
    .action(async (provider: string | undefined, o: { gateway?: string; verify: boolean }) => {
      if (o.gateway === undefined) {
        if (provider === undefined) {
          err(`Say what to log in to: vinax login <${PROVIDERS}>, or vinax login --gateway <url>`);
          setExit(EXIT.usage);
          return;
        }
        setExit(await storeProviderKey(io, provider, o.verify));
        return;
      }
      const url = o.gateway.replace(/\/+$/, '');
      const problem = gatewayUrlProblem(url);
      if (problem !== undefined) {
        err(`✖ ${problem}`);
        setExit(EXIT.usage);
        return;
      }
      const token =
        io.env[SECRET_ENV_VARS.gateway] ?? (await readSecret(io, 'VinaX gateway token: '));
      if (token === '') {
        err('No token given. Ask whoever runs the gateway for one.');
        setExit(EXIT.usage);
        return;
      }
      if (o.verify) {
        const { resolved } = await loadSettings({ cwd: io.cwd, env: io.env });
        const check = await checkGateway(url, token, {
          timeoutMs: resolved.gateway.timeoutMs,
          onWaking: () => {
            err(paint(io.stderr, 'dim', GATEWAY_WAKING, io.env));
          },
        });
        if (!check.ok) {
          err(`✖ ${check.reason}${check.rejected ? '; nothing was saved.' : ''}`);
          if (check.rejected) {
            setExit(EXIT.error);
            return;
          }
          err('⚠ Saving the gateway anyway; VinaX will try it again on the first request.');
        } else {
          out(
            `✔ Connected to the VinaX gateway${check.version === undefined ? '' : ` v${check.version}`} (${String(check.models)} models).`,
          );
        }
      }
      const where = await saveGatewayLogin(url, token, { cwd: io.cwd, env: io.env });
      out(
        `✔ Saved ${url} to your user settings and the token to the ${where === 'keychain' ? 'OS keychain' : 'credentials file'}.`,
      );
      const store = await openSecretStore(io.env);
      const own: (typeof PROVIDER_NAMES)[number][] = [];
      for (const p of PROVIDER_NAMES) if ((await store.get(p)) !== undefined) own.push(p);
      out(
        own.length === 0
          ? 'Every request now goes through the gateway.'
          : `${own.map(providerLabel).join(' and ')} still use${own.length === 1 ? 's' : ''} your own key; other providers go through the gateway.`,
      );
    });
}

export function logoutCommand(io: CliIO, setExit: (code: number) => void): Command {
  const out = (s: string) => io.stdout.write(`${s}\n`);
  const err = (s: string) => io.stderr.write(`${s}\n`);
  return new Command('logout')
    .description(`Remove a stored provider key (${PROVIDERS}), or disconnect with --gateway`)
    .argument('[provider]', PROVIDERS)
    .option('--gateway', 'stop using the VinaX gateway and delete its token')
    .action(async (provider: string | undefined, o: { gateway?: boolean }) => {
      if (o.gateway === true) {
        const removed = await removeGatewayLogin({ cwd: io.cwd, env: io.env });
        out(removed ? 'Disconnected from the VinaX gateway.' : 'No gateway was configured.');
        if (io.env[SECRET_ENV_VARS.gateway] !== undefined)
          err(`Note: ${SECRET_ENV_VARS.gateway} is still set in your environment.`);
        return;
      }
      if (provider === undefined || !(PROVIDER_NAMES as readonly string[]).includes(provider)) {
        err(`Say what to log out of: vinax logout <${PROVIDERS}>, or vinax logout --gateway`);
        setExit(EXIT.usage);
        return;
      }
      const name = provider as (typeof PROVIDER_NAMES)[number];
      const removed = await (await openSecretStore(io.env)).delete(name);
      out(removed ? `Removed the stored ${providerLabel(name)} key.` : 'No stored key.');
      if (io.env[SECRET_ENV_VARS[name]] !== undefined)
        err(`Note: ${SECRET_ENV_VARS[name]} is still set in your environment.`);
    });
}
