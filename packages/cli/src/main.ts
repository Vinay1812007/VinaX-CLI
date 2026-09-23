import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { modelRefSchema, SettingsError } from '@vinax/core';
import { configCommand } from './config-command.js';
import { EXIT } from './exit-codes.js';
import { paint, processIO, type CliIO } from './io.js';
import { OUTPUT_FORMATS, runPrint, type OutputFormat } from './print.js';
import { VERSION } from './version.js';

interface RootOptions {
  print?: boolean;
  outputFormat: OutputFormat;
  model?: string;
  verbose?: boolean;
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
      if (opts.print !== true) {
        io.stderr.write(
          'The interactive UI is not built yet (milestone M2). For now use print mode:\n  vinax -p "<prompt>"\n',
        );
        setExit(EXIT.usage);
        return;
      }
      setExit(
        await runPrint(
          {
            prompt,
            outputFormat: opts.outputFormat,
            model: opts.model,
            verbose: opts.verbose === true,
          },
          io,
          signal,
        ),
      );
    });

  program.addCommand(configCommand(io, setExit).exitOverride());

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
