import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { modelRefSchema, PERMISSION_MODES, SettingsError, type PermissionMode } from '@vinax/core';
import { configCommand } from './config-command.js';
import { doctorCommand } from './doctor-command.js';
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
  continue?: boolean;
  resume?: boolean | string;
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
    continueLast: o.continue === true,
    resume: o.resume,
  };
}

function parseModel(value: string): string {
  const parsed = modelRefSchema.safeParse(value);
  if (!parsed.success)
    throw new InvalidArgumentError(parsed.error.issues[0]?.message ?? 'invalid model');
  return parsed.data;
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
    .description('VinaX: an agentic coding assistant for your terminal')
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
      'model to use first, e.g. groq:openai/gpt-oss-120b',
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
      const session = sessionOptions(prompt, opts);
      if (opts.print !== true) {
        setExit(await runInteractive(session, io));
        return;
      }
      setExit(await runPrint({ ...session, outputFormat: opts.outputFormat }, io, signal));
    });

  program.addCommand(configCommand(io, setExit).exitOverride());
  program.addCommand(doctorCommand(io, setExit).exitOverride());

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
