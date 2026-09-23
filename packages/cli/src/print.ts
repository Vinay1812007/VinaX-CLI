import {
  attachMentions,
  createRuntime,
  providerLabel,
  formatModelRef,
  SECRET_ENV_VARS,
  SettingsError,
  type AgentEvent,
  type AgentHost,
  type AgentOutcome,
  type Runtime,
} from '@vinax/core';
import { EXIT } from './exit-codes.js';
import { paint, readAll, type CliIO } from './io.js';
import { openSession } from './session.js';
import { cliSettings, type SessionOptions } from './session-options.js';
import { VERSION } from './version.js';

export const OUTPUT_FORMATS = ['text', 'json', 'stream-json'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export interface PrintOptions extends SessionOptions {
  outputFormat: OutputFormat;
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

const TOOL_OUTPUT_IN_STREAM = 4000;

/** Renders agent events and the final result in the requested output format. */
class Output {
  private text = '';
  private readonly fallbacks: FallbackRecord[] = [];
  private toolCalls = 0;
  sessionId: string | undefined;

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

  init(chain: string[], cwd: string, mode: string): void {
    if (this.format === 'stream-json') {
      this.line({
        type: 'system',
        subtype: 'init',
        version: VERSION,
        cwd,
        models: chain,
        permission_mode: mode,
      });
    }
  }

  private writeText(t: string): void {
    this.text += t;
    if (this.format === 'text') this.io.stdout.write(t);
    else if (this.format === 'stream-json') this.line({ type: 'text', text: t });
  }

  event(ev: AgentEvent): void {
    switch (ev.type) {
      case 'text':
        this.writeText(ev.text);
        return;
      case 'tool_call':
        this.toolCalls++;
        // keep separate steps' prose apart in plain-text output
        if (this.format === 'text' && this.text !== '' && !this.text.endsWith('\n'))
          this.writeText('\n');
        if (this.format === 'stream-json')
          this.line({ type: 'tool_use', id: ev.id, name: ev.name, input: ev.input });
        if (this.verbose) this.notice(`▸ ${ev.name} ${ev.label}`);
        return;
      case 'tool_result':
        if (this.format === 'stream-json') {
          this.line({
            type: 'tool_result',
            id: ev.id,
            name: ev.name,
            is_error: !ev.ok,
            summary: ev.summary,
            content: ev.content.slice(0, TOOL_OUTPUT_IN_STREAM),
          });
        }
        if (this.verbose) this.notice(`  └ ${ev.summary}`);
        return;
      case 'notice':
        if (this.format === 'stream-json')
          this.line({ type: 'notice', kind: 'info', text: ev.text });
        this.notice(`↪ ${ev.text}`);
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
      case 'tool_progress':
      case 'done':
        return;
    }
  }

  finish(outcome: AgentOutcome | undefined, durationMs: number, error?: string): void {
    const failed = error !== undefined;
    if (this.format === 'text') {
      if (this.text !== '' && !this.text.endsWith('\n')) this.io.stdout.write('\n');
    } else {
      this.line({
        type: 'result',
        subtype: failed ? 'error' : 'success',
        is_error: failed,
        result: outcome?.text ?? this.text,
        ...(failed ? { error } : {}),
        model: outcome?.models.at(-1) ?? null,
        usage: outcome
          ? {
              input_tokens: outcome.usage.promptTokens,
              output_tokens: outcome.usage.completionTokens,
            }
          : null,
        session_id: this.sessionId ?? null,
        num_turns: outcome?.steps ?? 0,
        tool_calls: this.toolCalls,
        fallbacks: this.fallbacks,
        duration_ms: durationMs,
      });
    }
    if (failed)
      this.io.stderr.write(`${paint(this.io.stderr, 'red', `✖ ${error}`, this.io.env)}\n`);
  }
}

function noKeysMessage(): string {
  return [
    'No API key found for any provider.',
    `  Set ${SECRET_ENV_VARS.groq} or ${SECRET_ENV_VARS.openrouter},`,
    '  or store one with: vinax config set-key groq',
  ].join('\n');
}

/** Actions that need approval fail with this hint instead of hanging: nobody can answer in -p. */
function headlessHost(runtime: Runtime): AgentHost {
  const mode = runtime.settings.resolved.permissions.defaultMode;
  return {
    mode: () => mode,
    askPermission: (req) =>
      Promise.resolve({
        kind: 'unavailable',
        message: [
          `Not allowed: ${req.reason} Print mode cannot ask for approval.`,
          req.suggestion === undefined
            ? 'The user can allow it with --allowedTools or --permission-mode acceptEdits.'
            : `The user can allow it with --allowedTools "${req.suggestion}".`,
          'Continue without this action if possible, and say what was skipped.',
        ].join(' '),
      }),
  };
}

/** `vinax -p`: runs the agent once, non-interactively, and prints the result. */
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
    const cli = cliSettings(opts);
    runtime = await createRuntime({
      cwd: io.cwd,
      env: io.env,
      verbose: opts.verbose,
      ...(cli === undefined ? {} : { cli }),
      ...(opts.model === undefined ? {} : { modelOverride: opts.model }),
    });
  } catch (err) {
    out.finish(
      undefined,
      Date.now() - started,
      err instanceof SettingsError ? err.message : String(err),
    );
    return EXIT.error;
  }
  for (const w of runtime.warnings) out.notice(`⚠ ${w}`);
  if (runtime.logger.file !== undefined) out.notice(`debug log: ${runtime.logger.file}`);
  if (runtime.providers.size === 0) {
    out.finish(undefined, Date.now() - started, noKeysMessage());
    return EXIT.error;
  }

  if (opts.resume === true) {
    out.finish(
      undefined,
      Date.now() - started,
      'In print mode, pass the session id: vinax -p -r <session-id> "…" (or use -c for the latest).',
    );
    return EXIT.usage;
  }
  let opened;
  try {
    opened = await openSession(
      runtime,
      typeof opts.resume === 'string'
        ? { kind: 'resume', id: opts.resume }
        : opts.continueLast
          ? { kind: 'continue' }
          : { kind: 'new' },
      { maxTurns: opts.maxTurns, model: opts.model },
    );
  } catch (err) {
    out.finish(
      undefined,
      Date.now() - started,
      `Could not open the session: ${err instanceof Error ? err.message : String(err)}`,
    );
    return EXIT.error;
  }
  const { setup } = opened;
  for (const n of opened.notes) out.notice(`⚠ ${n}`);
  for (const bad of setup.permissions.invalidRules)
    out.notice(`⚠ Ignoring malformed permission rule: ${bad}`);

  const ac = new AbortController();
  const onAbort = (): void => {
    ac.abort();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  const mode = runtime.settings.resolved.permissions.defaultMode;
  out.sessionId = opened.writer.id;
  out.init(runtime.router.chain('main', opts.model).map(formatModelRef), io.cwd, mode);
  try {
    const withFiles = await attachMentions(prompt, {
      cwd: io.cwd,
      workspace: setup.workspace,
      reads: setup.reads,
    });
    const outcome = await setup.agent.run(withFiles.prompt, {
      signal: ac.signal,
      host: headlessHost(runtime),
      onEvent: (ev) => {
        out.event(ev);
      },
    });
    const elapsed = Date.now() - started;
    switch (outcome.status) {
      case 'done':
        out.finish(outcome, elapsed);
        return EXIT.ok;
      case 'interrupted':
        out.finish(outcome, elapsed, 'Interrupted');
        return EXIT.interrupted;
      default:
        out.finish(outcome, elapsed, outcome.error ?? `Stopped: ${outcome.status}`);
        return EXIT.error;
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await setup.close();
  }
}
