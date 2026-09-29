import { execFile } from 'node:child_process';
import { loadSettings, SettingsError } from './config/load.js';
import type { Env } from './config/paths.js';
import { openSecretStore, SECRET_ENV_VARS } from './config/secrets.js';
import { providerLabel } from './providers/errors.js';
import { GatewayClient } from './providers/gateway.js';
import { loadMcpConfig } from './mcp/config.js';
import type { McpServerState } from './mcp/manager.js';
import { PROVIDER_NAMES } from './providers/types.js';
import type { Runtime } from './runtime.js';
import { ripgrepStatus } from './tools/search-tools.js';
import { detectShell } from './tools/shell.js';

export type DoctorGroup = 'runtime' | 'providers' | 'tools' | 'integrations';

export interface DoctorCheck {
  name: string;
  /** `skip`: optional and not set up (e.g. a provider you do not use). */
  status: 'ok' | 'warn' | 'fail' | 'skip';
  detail: string;
  group: DoctorGroup;
}

export interface DoctorOptions {
  cwd: string;
  env: Env;
  version: string;
  /** When given, keys are checked live and model availability is reported. */
  runtime?: Runtime;
  /** Live MCP server states (interactive sessions); otherwise the MCP config is only read. */
  mcp?: readonly Pick<McpServerState, 'name' | 'status' | 'error' | 'tools'>[];
  terminal: { isTTY: boolean; columns: number | undefined };
}

function commandVersion(cmd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 3000 }, (err, stdout) => {
      resolve(err ? undefined : stdout.trim().split('\n')[0]);
    });
  });
}

async function keychainAvailable(): Promise<boolean> {
  try {
    const mod = (await import('@napi-rs/keyring')) as {
      Entry: new (s: string, a: string) => { getPassword(): string | null };
    };
    new mod.Entry('vinax', '__doctor_probe__').getPassword();
    return true;
  } catch {
    return false;
  }
}

/** Checks the installation, settings, keys, search, shell, terminal, gateway and MCP. */
export async function runDoctor(opts: DoctorOptions): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  let group: DoctorGroup = 'runtime';
  const add = (name: string, status: DoctorCheck['status'], detail: string): void => {
    checks.push({ name, status, detail, group });
  };

  const bun = (process.versions as Record<string, string | undefined>).bun;
  const major = Number(process.versions.node.split('.')[0]);
  if (bun === undefined) {
    add(
      'Node.js',
      major >= 22 ? 'ok' : 'fail',
      `v${process.versions.node}${major >= 22 ? '' : ' — VinaX needs Node.js 22 or newer'}`,
    );
  } else {
    add('Runtime', 'ok', `standalone binary (Bun ${bun})`);
  }
  add('VinaX', 'ok', `v${opts.version}`);

  let gatewayUrl: string | undefined;
  try {
    const loaded = await loadSettings({ cwd: opts.cwd, env: opts.env });
    gatewayUrl = loaded.resolved.gateway.url;
    add(
      'Settings',
      loaded.warnings.length === 0 ? 'ok' : 'warn',
      loaded.warnings.length === 0 ? 'all settings files are valid' : loaded.warnings.join('; '),
    );
  } catch (err) {
    add('Settings', 'fail', err instanceof SettingsError ? err.message : String(err));
  }

  group = 'providers';
  const store = await openSecretStore(opts.env);
  const gatewayToken = gatewayUrl === undefined ? undefined : await store.get('gateway');
  const viaGateway = gatewayToken !== undefined;
  const secrets = await Promise.all(PROVIDER_NAMES.map((name) => store.get(name)));
  const anyKey = secrets.some((s) => s !== undefined);
  // live key checks run in parallel: each can take a network round trip
  const results = await Promise.all(
    PROVIDER_NAMES.map(async (name, i) => {
      const secret = secrets[i];
      const label = `${providerLabel(name)} key`;
      if (!secret) {
        const how = `set ${SECRET_ENV_VARS[name]} or run: vinax config set-key ${name}`;
        return viaGateway
          ? ([label, 'ok', 'not set — requests go through the VinaX gateway'] as const)
          : anyKey
            ? ([label, 'skip', `not set (optional: ${how})`] as const)
            : ([label, 'warn', `not set (${how})`] as const);
      }
      const provider = opts.runtime?.providers.get(name);
      if (!provider) return [label, 'ok', `found (${secret.source})`] as const;
      const check = await provider.validateKey(AbortSignal.timeout(10_000));
      return [
        label,
        check.ok ? 'ok' : check.rejected ? 'fail' : 'warn',
        check.ok ? `valid (${secret.source})` : check.reason,
      ] as const;
    }),
  );
  for (const [name, status, detail] of results) add(name, status, detail);
  if (!anyKey && !viaGateway) {
    add(
      'API keys',
      'fail',
      'no provider key or gateway is configured, so VinaX cannot answer (run: vinax login)',
    );
  }

  if (opts.runtime) {
    add(
      'Models',
      opts.runtime.warnings.length === 0 ? 'ok' : 'warn',
      opts.runtime.warnings.length === 0
        ? 'every configured model is available'
        : opts.runtime.warnings.join('; '),
    );
  }

  group = 'tools';
  const rg = await ripgrepStatus();
  add(
    'Search (Grep)',
    rg === 'javascript' ? 'warn' : 'ok',
    rg === 'javascript'
      ? 'ripgrep not found; using the slower JavaScript search'
      : `ripgrep (${rg})`,
  );
  const shell = detectShell(opts.env);
  add('Shell', 'ok', `${shell.label} (${shell.path})`);
  const git = await commandVersion('git', ['--version']);
  add(
    'Git',
    git === undefined ? 'warn' : 'ok',
    git ?? 'git not found; git-related tasks will fail',
  );
  const keychain = await keychainAvailable();
  add(
    'Key storage',
    keychain ? 'ok' : 'warn',
    keychain
      ? 'OS keychain'
      : 'OS keychain unavailable; keys are kept in ~/.vinax/credentials.json (mode 0600)',
  );

  group = 'runtime';
  const colors =
    opts.env.NO_COLOR !== undefined && opts.env.NO_COLOR !== ''
      ? 'NO_COLOR set'
      : opts.env.COLORTERM === 'truecolor' || opts.env.COLORTERM === '24bit'
        ? 'truecolor'
        : 'basic colours';
  add(
    'Terminal',
    opts.terminal.isTTY ? 'ok' : 'warn',
    opts.terminal.isTTY
      ? `${String(opts.terminal.columns ?? '?')} columns, ${colors}, TERM=${opts.env.TERM ?? 'unset'}${opts.env.TERM_PROGRAM === undefined ? '' : ` (${opts.env.TERM_PROGRAM})`}`
      : 'not a terminal (fine for vinax -p)',
  );
  group = 'integrations';
  if (gatewayUrl === undefined) {
    add('Gateway', 'ok', 'not used — requests go straight to the providers with your own keys');
  } else if (!viaGateway) {
    add(
      'Gateway',
      'warn',
      `${gatewayUrl} is configured but no token is stored (run: vinax login --gateway ${gatewayUrl})`,
    );
  } else {
    const probe = await new GatewayClient(gatewayUrl, { timeoutMs: 5000 }).probe(5000);
    add(
      'Gateway',
      probe.ok ? 'ok' : 'warn',
      probe.ok
        ? `${gatewayUrl} is up${probe.version === undefined ? '' : ` (v${probe.version})`}`
        : `${gatewayUrl} did not answer (${probe.reason}); it may be asleep, and the first request wakes it`,
    );
  }
  await checkMcp(opts, add);
  return checks;
}

async function checkMcp(
  opts: DoctorOptions,
  add: (name: string, status: DoctorCheck['status'], detail: string) => void,
): Promise<void> {
  if (opts.mcp !== undefined) {
    if (opts.mcp.length === 0) {
      add('MCP', 'skip', 'no servers configured');
      return;
    }
    const connected = opts.mcp.filter((s) => s.status === 'connected');
    const failed = opts.mcp.filter((s) => s.status === 'failed');
    const waiting = opts.mcp.filter((s) => s.status === 'needs-approval');
    const parts = [
      `${String(connected.length)}/${String(opts.mcp.length)} connected`,
      ...(failed.length === 0 ? [] : [`failed: ${failed.map((s) => s.name).join(', ')}`]),
      ...(waiting.length === 0
        ? []
        : [`awaiting approval: ${waiting.map((s) => s.name).join(', ')} (see /mcp)`]),
    ];
    add('MCP', failed.length > 0 ? 'warn' : 'ok', parts.join(' · '));
    return;
  }
  const { servers, errors } = await loadMcpConfig(opts.cwd, opts.env);
  if (errors.length > 0) {
    add('MCP', 'warn', errors.join('; '));
    return;
  }
  add(
    'MCP',
    servers.length === 0 ? 'skip' : 'ok',
    servers.length === 0
      ? 'no servers configured'
      : `${String(servers.length)} configured: ${servers.map((s) => `${s.name} (${s.scope})`).join(', ')}`,
  );
}
