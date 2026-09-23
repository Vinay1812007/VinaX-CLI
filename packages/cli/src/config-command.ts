import { Command, Option } from 'commander';
import {
  createProvider,
  loadSettings,
  maskSecret,
  noopLogger,
  openSecretStore,
  PROVIDER_NAMES,
  providerLabel,
  RateLimitLedger,
  SECRET_ENV_VARS,
  settingsPaths,
  updateSettingsFile,
  type ProviderName,
  type WritableScope,
} from '@vinax/core';
import { EXIT } from './exit-codes.js';
import { paint, readSecret, type CliIO } from './io.js';

const SCOPES = ['user', 'project', 'local'] as const;

function getPath(obj: unknown, dotted: string): unknown {
  let node = obj;
  for (const seg of dotted.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[seg];
  }
  return node;
}

function setPath(
  obj: Record<string, unknown>,
  dotted: string,
  value: unknown,
): Record<string, unknown> {
  const segs = dotted.split('.');
  const last = segs.pop();
  if (last === undefined || last === '') throw new Error('Empty setting key');
  let node = obj;
  for (const seg of segs) {
    const next = node[seg];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) node[seg] = {};
    node = node[seg] as Record<string, unknown>;
  }
  if (value === undefined) Reflect.deleteProperty(node, last);
  else node[last] = value;
  return obj;
}

/** `true`, `42`, `["a"]` are parsed as JSON; anything else is kept as a string. */
function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function isProvider(name: string): name is ProviderName {
  return (PROVIDER_NAMES as readonly string[]).includes(name);
}

export function configCommand(io: CliIO, setExit: (code: number) => void): Command {
  const out = (s: string): void => {
    io.stdout.write(`${s}\n`);
  };
  const err = (s: string): void => {
    io.stderr.write(`${s}\n`);
  };
  const scopeOption = (): Option =>
    new Option('--scope <scope>', 'settings file to change').choices(SCOPES).default('user');

  const cmd = new Command('config').description('View and edit VinaX settings and API keys');

  cmd
    .command('list')
    .description('Show effective settings (defaults merged with every settings file)')
    .action(async () => {
      const loaded = await loadSettings({ cwd: io.cwd, env: io.env });
      for (const w of loaded.warnings) err(`⚠ ${w}`);
      out(JSON.stringify(loaded.resolved, null, 2));
      const paths = settingsPaths(io.cwd, io.env);
      out('');
      out(paint(io.stdout, 'dim', 'Settings files (lowest to highest precedence):', io.env));
      for (const scope of SCOPES)
        out(paint(io.stdout, 'dim', `  ${scope.padEnd(8)}${paths[scope]}`, io.env));
    });

  cmd
    .command('get <key>')
    .description('Print one effective setting, e.g. "router.maxRetries"')
    .action(async (key: string) => {
      const loaded = await loadSettings({ cwd: io.cwd, env: io.env });
      const value = getPath(loaded.resolved, key);
      if (value === undefined) {
        err(`Unknown setting "${key}"`);
        setExit(EXIT.error);
        return;
      }
      out(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    });

  cmd
    .command('set <key> <value>')
    .description('Set a value in a settings file (JSON values like 3, true or ["a"] are parsed)')
    .addOption(scopeOption())
    .action(async (key: string, value: string, o: { scope: WritableScope }) => {
      const file = await updateSettingsFile({ cwd: io.cwd, env: io.env, scope: o.scope }, (s) =>
        setPath(s, key, parseValue(value)),
      );
      out(`Set ${key} in ${file}`);
    });

  cmd
    .command('unset <key>')
    .description('Remove a value from a settings file')
    .addOption(scopeOption())
    .action(async (key: string, o: { scope: WritableScope }) => {
      const file = await updateSettingsFile({ cwd: io.cwd, env: io.env, scope: o.scope }, (s) =>
        setPath(s, key, undefined),
      );
      out(`Removed ${key} from ${file}`);
    });

  cmd
    .command('keys')
    .description('Show which provider API keys are configured and where they come from')
    .action(async () => {
      const store = await openSecretStore(io.env);
      for (const name of PROVIDER_NAMES) {
        const secret = await store.get(name);
        const status = secret
          ? `${maskSecret(secret.value)}  (${secret.source === 'env' ? SECRET_ENV_VARS[name] : secret.source})`
          : paint(io.stdout, 'dim', 'not set', io.env);
        out(`${providerLabel(name).padEnd(11)} ${status}`);
      }
    });

  cmd
    .command('set-key <provider>')
    .description(`Store an API key (${PROVIDER_NAMES.join(' | ')}); reads it from stdin when piped`)
    .option('--no-verify', 'store without a live check against the provider')
    .action(async (provider: string, o: { verify: boolean }) => {
      if (!isProvider(provider)) {
        err(`Unknown provider "${provider}". Choose one of: ${PROVIDER_NAMES.join(', ')}`);
        setExit(EXIT.usage);
        return;
      }
      const key = await readSecret(io, `${providerLabel(provider)} API key: `);
      if (key === '') {
        err('No key given.');
        setExit(EXIT.usage);
        return;
      }
      if (o.verify) {
        const { resolved } = await loadSettings({ cwd: io.cwd, env: io.env });
        const check = await createProvider(provider, key, {
          settings: resolved,
          ledger: new RateLimitLedger(() => Number.POSITIVE_INFINITY),
          logger: noopLogger,
        }).validateKey();
        if (!check.ok && check.rejected) {
          err(`✖ ${providerLabel(provider)} rejected that key; it was not saved.`);
          setExit(EXIT.error);
          return;
        }
        if (!check.ok) err(`⚠ Could not verify the key (${check.reason}); saving it anyway.`);
      }
      const store = await openSecretStore(io.env);
      const where = await store.set(provider, key);
      out(
        `✔ Saved ${providerLabel(provider)} key to the ${where === 'keychain' ? 'OS keychain' : 'credentials file'}.`,
      );
      if (io.env[SECRET_ENV_VARS[provider]] !== undefined) {
        err(`Note: ${SECRET_ENV_VARS[provider]} is set and takes precedence over the stored key.`);
      }
    });

  cmd
    .command('remove-key <provider>')
    .description('Delete a stored API key')
    .action(async (provider: string) => {
      if (!isProvider(provider)) {
        err(`Unknown provider "${provider}". Choose one of: ${PROVIDER_NAMES.join(', ')}`);
        setExit(EXIT.usage);
        return;
      }
      const store = await openSecretStore(io.env);
      out(
        (await store.delete(provider))
          ? `Removed the stored ${providerLabel(provider)} key.`
          : 'No stored key.',
      );
    });

  return cmd;
}
