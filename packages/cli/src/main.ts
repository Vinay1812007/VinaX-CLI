import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import {
  MODEL_REF_HINT,
  normalizeModelRef,
  PERMISSION_MODES,
  SettingsError,
  type PermissionMode,
} from '@vinax/core';
import { configCommand } from './config-command.js';
import { doctorCommand, healthCommand } from './doctor-command.js';
import { loginCommand, logoutCommand } from './login-command.js';
import { mcpCommand } from './mcp-command.js';
import {
  enterWorktree,
  worktreeBanner,
  worktreeCommand,
  worktreeNextSteps,
} from './worktree-command.js';
import { cleanupOldBinary, detectInstall, runUpdate } from './update.js';
import { EXIT } from './exit-codes.js';
import { runInteractive } from './interactive.js';
import { paint, processIO, type CliIO } from './io.js';
import { OUTPUT_FORMATS, runPrint, type OutputFormat } from './print.js';
import type { SessionOptions } from './session-options.js';
import { VERSION } from './version.js';

interface RootOptions {
  print?: boolean;
  outputFormat: OutputFormat;
  model?: string;
  verbose?: boolean;
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  addDir?: string[];
  maxTurns?: number;
  tokenBudget?: number;
  timeBudget?: number;
  continue?: boolean;
  resume?: boolean | string;
  worktree?: boolean | string;
}

function parsePositiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1)
    throw new InvalidArgumentError('expected a whole number of at least 1');
  return n;
}

/** Accepts both repeated flags and comma/space separated lists: --allowedTools "Read,Bash(git:*)". */
function collectRules(value: string, previous: string[] = []): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === ',' || ch === ' ')) {
      if (current.trim() !== '') parts.push(current.trim());
      current = '';
    } else current += ch;
  }
  if (current.trim() !== '') parts.push(current.trim());
  return [...previous, ...parts];
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function sessionOptions(prompt: string | undefined, o: RootOptions): SessionOptions {
  return {
    prompt,
    model: o.model,
    verbose: o.verbose === true,
    permissionMode: o.permissionMode,
    allowedTools: o.allowedTools ?? [],
    disallowedTools: o.disallowedTools ?? [],
    addDirs: o.addDir ?? [],
    maxTurns: o.maxTurns,
    tokenBudget: o.tokenBudget,
    timeBudget: o.timeBudget,
    continueLast: o.continue === true,
    resume: o.resume,
  };
}

/** Accepts `<provider>:<model>`, a provider domain or an alias; returns the canonical ref. */
function parseModel(value: string): string {
  const ref = normalizeModelRef(value);
  if (ref === undefined) throw new InvalidArgumentError(MODEL_REF_HINT);
  return ref;
}

/** Runs the CLI and resolves to the process exit code. */
export async function main(
  argv: readonly string[],
  io: CliIO = processIO(),
  signal?: AbortSignal,
): Promise<number> {
  let exitCode: number = EXIT.ok;
  const setExit = (code: number): void => {
    exitCode = code;
  };

  const program = new Command('vinax')
    .description('VinaX: your AI coding agent for the terminal')
    .version(VERSION, '-v, --version', 'print the version')
    .helpOption('-h, --help', 'show help')
    .argument('[prompt]', 'initial prompt')
    .option('-p, --print', 'answer once without the interactive UI, then exit (reads piped stdin)')
    .addOption(
      new Option('--output-format <format>', 'print-mode output format')
        .choices(OUTPUT_FORMATS)
        .default('text'),
    )
    .option(
      '--model <provider:model>',
      'model to use first, e.g. groq:openai/gpt-oss-120b, nvidia:openai/gpt-oss-20b or an alias like NVD_CHAT_OSS_20_B',
      parseModel,
    )
    .addOption(
      new Option('--permission-mode <mode>', 'start in this mode').choices(PERMISSION_MODES),
    )
    .option(
      '--allowedTools <rules>',
      'allow these tools without asking, e.g. "Bash(npm test:*),Edit"',
      collectRules,
    )
    .option(
      '--disallowedTools <rules>',
      'never allow these tools, e.g. "Bash(git push:*)"',
      collectRules,
    )
    .option('--add-dir <path>', 'also let tools work in this folder (repeatable)', collect)
    .option('--max-turns <n>', 'stop after this many model calls per prompt', parsePositiveInt)
    .option(
      '--token-budget <n>',
      'stop a task after it uses this many tokens (reported or estimated, sub-agents included)',
      parsePositiveInt,
    )
    .option('--time-budget <seconds>', 'stop a task after this many seconds', parsePositiveInt)
    .option(
      '-w, --worktree [name]',
      'work in an isolated git worktree (created from HEAD if needed); review and apply with vinax worktree',
    )
    .option('-c, --continue', 'continue the most recent conversation in this folder')
    .option('-r, --resume [session-id]', 'resume a conversation (shows a picker without an id)')
    .option('--verbose', 'write a debug log of every request (API keys redacted)')
    .configureOutput({
      writeOut: (s) => io.stdout.write(s),
      writeErr: (s) => io.stderr.write(s),
      outputError: (s, write) => {
        write(paint(io.stderr, 'red', s, io.env));
      },
    })
    .exitOverride()
    .action(async (prompt: string | undefined, opts: RootOptions) => {
      let session = sessionOptions(prompt, opts);
      let runIO = io;
      if (opts.worktree !== undefined && opts.worktree !== false) {
        try {
          const wt = await enterWorktree(io, opts.worktree);
          runIO = { ...io, cwd: wt.cwd };
          const banner = worktreeBanner(wt.info, wt.created);
          session = { ...session, worktree: wt.info.name, notices: [banner] };
          if (opts.print === true) io.stderr.write(`${paint(io.stderr, 'dim', banner, io.env)}\n`);
        } catch (e) {
          io.stderr.write(
            `${paint(io.stderr, 'red', e instanceof Error ? e.message : String(e), io.env)}\n`,
          );
          setExit(EXIT.error);
          return;
        }
      }
      if (opts.print !== true) {
        setExit(await runInteractive(session, runIO));
        return;
      }
      setExit(await runPrint({ ...session, outputFormat: opts.outputFormat }, runIO, signal));
      if (session.worktree !== undefined)
        io.stderr.write(
          `${paint(io.stderr, 'dim', `Changes are in worktree ${session.worktree}:\n${worktreeNextSteps(session.worktree).join('\n')}`, io.env)}\n`,
        );
    });

  program.addCommand(configCommand(io, setExit).exitOverride());
  program.addCommand(doctorCommand(io, setExit).exitOverride());
  program.addCommand(healthCommand(io, setExit).exitOverride());
  program.addCommand(mcpCommand(io, setExit).exitOverride());
  program.addCommand(worktreeCommand(io, setExit).exitOverride());
  program.addCommand(loginCommand(io, setExit));
  program.addCommand(logoutCommand(io, setExit));
  program.addCommand(
    new Command('update')
      .description('Update VinaX to the latest release (the same way it was installed)')
      .option('--check', 'only report whether an update is available')
      .action(async (o: { check?: boolean }) => {
        setExit(
          await runUpdate(
            VERSION,
            { check: o.check === true, env: io.env },
            {
              out: (s) => io.stdout.write(`${s}\n`),
              err: (s) => io.stderr.write(`${s}\n`),
            },
          ),
        );
      }),
  );
  void cleanupOldBinary(detectInstall());
  // nested subcommands (config set, mcp add, …) must report errors instead of exiting the process
  const everyCommand = (c: Command): Command[] => [c, ...c.commands.flatMap(everyCommand)];
  for (const c of everyCommand(program)) {
    c.exitOverride();
    c.configureOutput({
      writeOut: (s) => io.stdout.write(s),
      writeErr: (s) => io.stderr.write(s),
      outputError: (s, write) => {
        write(paint(io.stderr, 'red', s, io.env));
      },
    });
  }

  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (err) {
    if (err instanceof CommanderError) return err.exitCode === 0 ? EXIT.ok : EXIT.usage;
    if (err instanceof SettingsError) {
      io.stderr.write(`${paint(io.stderr, 'red', err.message, io.env)}\n`);
      return EXIT.error;
    }
    throw err;
  }
  return exitCode;
}
