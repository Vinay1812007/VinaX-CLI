import { execa } from 'execa';
import type { Env } from '../config/paths.js';
import type { HookEvent, HookMatcher } from '../config/schema.js';
import type { ShellInfo } from '../tools/shell.js';

export interface HookResult {
  /** A hook said no (exit code 2, or `{"decision":"block"}`). */
  blocked: boolean;
  /** Why it blocked (stderr or `reason`); fed back to the model or shown to the user. */
  message: string | undefined;
  /** A PreToolUse hook approved the call (`{"decision":"approve"}`), skipping the prompt. */
  approved: boolean;
  /** Extra context from stdout (`additionalContext`, or plain text for prompt/session hooks). */
  context: string[];
  /** Hooks that failed without blocking (bad exit code, timeout). */
  warnings: string[];
}

const DEFAULT_TIMEOUT_S = 60;

/** `Bash`, `Edit|Write`, `Read, Grep` are name lists; anything else is a regular expression. */
export function matcherMatches(matcher: string | undefined, toolName: string | undefined): boolean {
  if (matcher === undefined || matcher === '' || matcher === '*') return true;
  if (toolName === undefined) return false;
  if (/^[\w\s|,-]+$/.test(matcher)) return matcher.split(/[|,]/).some((m) => m.trim() === toolName);
  try {
    return new RegExp(matcher).test(toolName);
  } catch {
    return false;
  }
}

function shellArgs(shell: ShellInfo, command: string): string[] {
  return shell.kind === 'powershell'
    ? ['-NoProfile', '-NonInteractive', '-Command', command]
    : ['-c', command];
}

interface HookJson {
  decision?: unknown;
  reason?: unknown;
  additionalContext?: unknown;
  continue?: unknown;
  stopReason?: unknown;
}

/**
 * Runs the shell-command hooks configured in settings. Each hook gets the event as JSON on stdin.
 * Exit 0 continues (stdout may carry JSON or context), exit 2 blocks and its stderr explains why,
 * any other exit is reported but does not block.
 */
export class HookRunner {
  constructor(
    private readonly config: Partial<Record<HookEvent, HookMatcher[]>>,
    private readonly opts: {
      cwd: string;
      env: Env;
      shell: ShellInfo;
      disabled: boolean;
      base: () => Record<string, unknown>;
    },
  ) {}

  /** Configured matcher groups, for /hooks. */
  get configured(): Partial<Record<HookEvent, HookMatcher[]>> {
    return this.config;
  }

  has(event: HookEvent, toolName?: string): boolean {
    return (
      !this.opts.disabled &&
      (this.config[event] ?? []).some((m) => matcherMatches(m.matcher, toolName))
    );
  }

  async run(
    event: HookEvent,
    input: Record<string, unknown>,
    opts: { toolName?: string; signal?: AbortSignal } = {},
  ): Promise<HookResult> {
    const result: HookResult = {
      blocked: false,
      message: undefined,
      approved: false,
      context: [],
      warnings: [],
    };
    if (!this.has(event, opts.toolName)) return result;
    const payload = JSON.stringify({
      ...this.opts.base(),
      ...input,
      hook_event_name: event,
      cwd: this.opts.cwd,
    });
    const plainTextIsContext = event === 'UserPromptSubmit' || event === 'SessionStart';
    for (const group of this.config[event] ?? []) {
      if (!matcherMatches(group.matcher, opts.toolName)) continue;
      for (const hook of group.hooks) {
        const r = await execa(this.opts.shell.path, shellArgs(this.opts.shell, hook.command), {
          cwd: this.opts.cwd,
          env: { ...this.opts.env, VINAX_PROJECT_DIR: this.opts.cwd, VINAX_HOOK_EVENT: event },
          extendEnv: false,
          input: payload,
          reject: false,
          timeout: (hook.timeout ?? DEFAULT_TIMEOUT_S) * 1000,
          ...(opts.signal === undefined ? {} : { cancelSignal: opts.signal }),
          windowsHide: true,
        });
        const stdout = typeof r.stdout === 'string' ? r.stdout.trim() : '';
        const stderr = typeof r.stderr === 'string' ? r.stderr.trim() : '';
        if (r.timedOut) {
          result.warnings.push(`${event} hook timed out: ${hook.command}`);
          continue;
        }
        if (r.exitCode === 2) {
          result.blocked = true;
          result.message = stderr === '' ? `Blocked by a ${event} hook (${hook.command})` : stderr;
          return result;
        }
        if (r.exitCode !== 0) {
          result.warnings.push(
            `${event} hook failed (exit ${String(r.exitCode ?? '?')}): ${hook.command}${stderr === '' ? '' : ` — ${stderr.split('\n')[0] ?? ''}`}`,
          );
          continue;
        }
        if (stdout.startsWith('{')) {
          let json: HookJson | undefined;
          try {
            json = JSON.parse(stdout) as HookJson;
          } catch {
            result.warnings.push(`${event} hook printed invalid JSON: ${hook.command}`);
          }
          if (json) {
            if (typeof json.additionalContext === 'string')
              result.context.push(json.additionalContext);
            if (json.decision === 'block' || json.continue === false) {
              result.blocked = true;
              const reason =
                typeof json.reason === 'string'
                  ? json.reason
                  : typeof json.stopReason === 'string'
                    ? json.stopReason
                    : undefined;
              result.message = reason ?? `Blocked by a ${event} hook`;
              return result;
            }
            if (json.decision === 'approve') result.approved = true;
          }
        } else if (stdout !== '' && plainTextIsContext) {
          result.context.push(stdout);
        }
      }
    }
    return result;
  }
}
