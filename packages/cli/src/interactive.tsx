import { render } from 'ink';
import {
  AppStateStore,
  checkGateway,
  createProvider,
  createRuntime,
  loadSettings,
  noopLogger,
  openSecretStore,
  RateLimitLedger,
  saveGatewayLogin,
  SECRET_ENV_VARS,
  updateSettingsFile,
  withKnownMetadata,
  type ProviderName,
} from '@vinax/core';
import { EXIT } from './exit-codes.js';
import type { CliIO } from './io.js';
import { openSession, sessionStore } from './session.js';
import { App, type AppDeps, type StartChoice } from './ui/App.js';
import { loadCommands } from './ui/commands/registry.js';
import { cliSettings, type SessionOptions } from './session-options.js';
import { pickTips } from './ui/tips.js';
import { writeExitSummary, type ExitSummary } from './exit-summary.js';
import { worktreeNextSteps } from './worktree-command.js';
import { startupAnnouncements } from './updates.js';
import { VERSION } from './version.js';

/** Real implementations behind the UI's dependency interfaces. */
export function createAppDeps(opts: SessionOptions, io: CliIO): AppDeps {
  const { cwd, env } = io;
  const scratchSettings = async () => (await loadSettings({ cwd, env })).resolved;
  const probe = async (provider: ProviderName, key: string) =>
    createProvider(provider, key, {
      settings: await scratchSettings(),
      ledger: new RateLimitLedger(() => Number.POSITIVE_INFINITY),
      logger: noopLogger,
    });
  return {
    state: new AppStateStore(env),
    loadTheme: async () => (await scratchSettings()).theme,
    createRuntime: () => {
      const cli = cliSettings(opts);
      return createRuntime({
        cwd,
        env,
        verbose: opts.verbose,
        ...(cli === undefined ? {} : { cli }),
        ...(opts.model === undefined ? {} : { modelOverride: opts.model }),
      });
    },
    openSession: async (runtime, choice, cleared) => {
      const opened = await openSession(runtime, choice, {
        maxTurns: opts.maxTurns,
        model: opts.model,
        cleared: cleared === true,
      });
      return { ...opened, notes: [...(opts.notices ?? []), ...opened.notes] };
    },
    listSessions: (runtime) => sessionStore(runtime).list(),
    loadCommands,
    onboarding: {
      envKey: (p) => {
        const v = env[SECRET_ENV_VARS[p]];
        return v === undefined || v.trim() === '' ? undefined : v.trim();
      },
      storedKey: async (p) =>
        (await (await openSecretStore({ ...env, [SECRET_ENV_VARS[p]]: undefined })).get(p))?.value,
      validateKey: async (p, key) => (await probe(p, key)).validateKey(),
      saveKey: async (p, key) => {
        await (await openSecretStore(env)).set(p, key);
      },
      listModels: async (p, key) => withKnownMetadata(p, await (await probe(p, key)).listModels()),
      saveSettings: async (patch) => {
        await updateSettingsFile({ cwd, env, scope: 'user' }, (s) => ({ ...s, ...patch }));
      },
      checkGateway: async (url, token, onWaking) =>
        checkGateway(url, token, {
          timeoutMs: (await scratchSettings()).gateway.timeoutMs,
          onWaking,
        }),
      saveGateway: async (url, token) => {
        await saveGatewayLogin(url, token, { cwd, env });
      },
      defaultModel: opts.model ?? 'groq:openai/gpt-oss-120b',
    },
    announcements: async () => {
      const { updateCheck } = await scratchSettings();
      return startupAnnouncements({
        current: VERSION,
        env: updateCheck ? env : { ...env, VINAX_NO_UPDATE_CHECK: '1' },
      });
    },
  };
}

function startChoice(opts: SessionOptions): StartChoice {
  if (opts.resume === true) return { kind: 'pick' };
  if (typeof opts.resume === 'string') return { kind: 'resume', id: opts.resume };
  return opts.continueLast ? { kind: 'continue' } : { kind: 'new' };
}

/** Runs the Ink UI until the user exits. Returns the process exit code. */
export async function runInteractive(opts: SessionOptions, io: CliIO): Promise<number> {
  if (io.stdin.isTTY !== true || io.stdout.isTTY !== true) {
    io.stderr.write(
      'Interactive mode needs a terminal. For scripts and pipes use: vinax -p "<prompt>"\n',
    );
    return EXIT.usage;
  }
  // the interactive UI redraws with cursor movement, which a dumb terminal cannot do
  if (io.env.TERM === 'dumb') {
    io.stderr.write(
      'TERM=dumb cannot show the interactive UI. Use vinax -p "<prompt>" here, or run VinaX in a terminal emulator.\n',
    );
    return EXIT.usage;
  }
  let code: number = EXIT.ok;
  let summary: ExitSummary | undefined;
  const instance = render(
    <App
      deps={createAppDeps(opts, io)}
      version={VERSION}
      cwd={io.cwd}
      env={io.env}
      tips={pickTips(3)}
      start={startChoice(opts)}
      initialPrompt={opts.prompt}
      onExit={(c, s) => {
        code = c;
        summary = s;
      }}
    />,
    {
      stdin: io.stdin as NodeJS.ReadStream,
      stdout: io.stdout as NodeJS.WriteStream,
      stderr: io.stderr as NodeJS.WriteStream,
      exitOnCtrlC: false,
      incrementalRendering: true,
    },
  );
  await instance.waitUntilExit();
  if (summary !== undefined) writeExitSummary(io, summary);
  if (opts.worktree !== undefined)
    io.stdout.write(
      `Your changes are in worktree ${opts.worktree}, not in your checkout:\n${worktreeNextSteps(opts.worktree).join('\n')}\n`,
    );
  return code;
}
