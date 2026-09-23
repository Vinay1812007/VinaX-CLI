import {
  AbortError,
  AllModelsFailedError,
  chatSystemPrompt,
  createRuntime,
  currentEnvironment,
  formatModelRef,
  providerLabel,
  SECRET_ENV_VARS,
  SettingsError,
  type ChatMessage,
  type RouterEvent,
  type Runtime,
  type Usage,
} from '@vinax/core';
import { paint, readAll, type CliIO } from './io.js';
import { EXIT } from './exit-codes.js';
import { VERSION } from './version.js';

export const OUTPUT_FORMATS = ['text', 'json', 'stream-json'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export interface PrintOptions {
  prompt: string | undefined;
  outputFormat: OutputFormat;
  model: string | undefined;
  verbose: boolean;
}

interface FallbackRecord {
  from: string;
  to: string;
  reason: string;
}

/** Piped stdin becomes context for the prompt; either one alone is also fine. */
export function composePrompt(prompt: string | undefined, piped: string): string {
  const p = prompt?.trim() ?? '';
  const input = piped.trim();
  if (p === '') return input;
  if (input === '') return p;
  return `${p}\n\n<stdin>\n${input}\n</stdin>`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

/** Renders router events and the final result in the requested output format. */
class Output {
  private text = '';
  private model: string | undefined;
  private usage: Usage | undefined;
  private readonly fallbacks: FallbackRecord[] = [];

  constructor(
    private readonly format: OutputFormat,
    private readonly io: CliIO,
    private readonly verbose: boolean,
  ) {}

  private line(obj: unknown): void {
    this.io.stdout.write(`${JSON.stringify(obj)}\n`);
  }

  notice(message: string): void {
    this.io.stderr.write(`${paint(this.io.stderr, 'dim', message, this.io.env)}\n`);
  }

  init(chain: string[], cwd: string): void {
    if (this.format === 'stream-json') {
      this.line({ type: 'system', subtype: 'init', version: VERSION, cwd, models: chain });
    }
  }

  event(ev: RouterEvent): void {
    switch (ev.type) {
      case 'text':
        this.text += ev.text;
        if (this.format === 'text') this.io.stdout.write(ev.text);
        else if (this.format === 'stream-json') this.line({ type: 'text', text: ev.text });
        return;
      case 'fallback': {
        const rec = { from: formatModelRef(ev.from), to: formatModelRef(ev.to), reason: ev.reason };
        this.fallbacks.push(rec);
        if (this.format === 'stream-json') this.line({ type: 'notice', kind: 'fallback', ...rec });
        this.notice(`↪ ${ev.reason} — switched to ${rec.to}`);
        return;
      }
      case 'wait':
        if (this.format === 'stream-json') {
          this.line({
            type: 'notice',
            kind: 'wait',
            model: formatModelRef(ev.ref),
            ms: ev.ms,
            reason: ev.reason,
          });
        }
        this.notice(`… waiting ${seconds(ev.ms)}: ${providerLabel(ev.ref.provider)} ${ev.reason}`);
        return;
      case 'retry':
        if (this.format === 'stream-json') {
          this.line({
            type: 'notice',
            kind: 'retry',
            model: formatModelRef(ev.ref),
            attempt: ev.attempt,
            delay_ms: ev.delayMs,
            reason: ev.reason,
          });
        }
        this.notice(`↻ ${ev.reason} — retrying in ${seconds(ev.delayMs)}`);
        return;
      case 'attempt':
        if (this.verbose) this.notice(`→ ${formatModelRef(ev.ref)}`);
        return;
      case 'done':
        this.model = formatModelRef(ev.ref);
        this.usage = ev.usage;
        return;
    }
  }

  private result(durationMs: number, error?: string): Record<string, unknown> {
    return {
      type: 'result',
      subtype: error === undefined ? 'success' : 'error',
      is_error: error !== undefined,
      result: this.text,
      ...(error === undefined ? {} : { error }),
      model: this.model ?? null,
      usage: this.usage
        ? { input_tokens: this.usage.promptTokens, output_tokens: this.usage.completionTokens }
        : null,
      fallbacks: this.fallbacks,
      duration_ms: durationMs,
    };
  }

  success(durationMs: number): void {
    if (this.format === 'text') {
      if (!this.text.endsWith('\n')) this.io.stdout.write('\n');
    } else {
      this.line(this.result(durationMs));
    }
  }

  failure(message: string, durationMs: number): void {
    if (this.format === 'text') {
      if (this.text !== '' && !this.text.endsWith('\n')) this.io.stdout.write('\n');
    } else {
      this.line(this.result(durationMs, message));
    }
    this.io.stderr.write(`${paint(this.io.stderr, 'red', `✖ ${message}`, this.io.env)}\n`);
  }
}

function noKeysMessage(): string {
  return [
    'No API key found for any provider.',
    `  Set ${SECRET_ENV_VARS.groq} or ${SECRET_ENV_VARS.openrouter},`,
    '  or store one with: vinax config set-key groq',
  ].join('\n');
}

/** `vinax -p`: one non-interactive completion streamed to stdout. Returns the exit code. */
export async function runPrint(
  opts: PrintOptions,
  io: CliIO,
  signal?: AbortSignal,
): Promise<number> {
  const started = Date.now();
  const out = new Output(opts.outputFormat, io, opts.verbose);
  const piped = io.stdin.isTTY === true ? '' : await readAll(io.stdin);
  const prompt = composePrompt(opts.prompt, piped);
  if (prompt === '') {
    io.stderr.write('No prompt given. Usage: vinax -p "<prompt>", or pipe text into vinax -p.\n');
    return EXIT.usage;
  }

  let runtime: Runtime;
  try {
    runtime = await createRuntime({
      cwd: io.cwd,
      env: io.env,
      verbose: opts.verbose,
      ...(opts.model === undefined
        ? {}
        : { cli: { model: opts.model }, modelOverride: opts.model }),
    });
  } catch (err) {
    out.failure(err instanceof SettingsError ? err.message : String(err), Date.now() - started);
    return EXIT.error;
  }
  for (const w of runtime.warnings) out.notice(`⚠ ${w}`);
  if (runtime.logger.file !== undefined) out.notice(`debug log: ${runtime.logger.file}`);
  if (runtime.providers.size === 0) {
    out.failure(noKeysMessage(), Date.now() - started);
    return EXIT.error;
  }

  const ac = new AbortController();
  const onAbort = (): void => {
    ac.abort();
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  const messages: ChatMessage[] = [
    { role: 'system', content: chatSystemPrompt(currentEnvironment(io.cwd)) },
    { role: 'user', content: prompt },
  ];
  out.init(runtime.router.chain('main').map(formatModelRef), io.cwd);
  try {
    for await (const ev of runtime.router.stream({ messages, signal: ac.signal })) out.event(ev);
    out.success(Date.now() - started);
    return EXIT.ok;
  } catch (err) {
    if (err instanceof AbortError) {
      out.failure('Interrupted', Date.now() - started);
      return EXIT.interrupted;
    }
    const message =
      err instanceof AllModelsFailedError || err instanceof Error ? err.message : String(err);
    runtime.logger.debug('print.failed', { message });
    out.failure(message, Date.now() - started);
    return EXIT.error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
