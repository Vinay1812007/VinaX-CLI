import { z } from 'zod';
import { splitCommands, type SimpleCommand } from '../permissions/shell-parse.js';
import type { ShellInfo } from './shell.js';
import { countLines, truncateMiddle } from './truncate.js';
import { defineTool, type AnyTool } from './types.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

const EDITORS = new Set(['vi', 'vim', 'nvim', 'nano', 'emacs', 'pico', 'micro', 'joe']);
const PAGERS = new Set(['less', 'more', 'most', 'man']);
const FULLSCREEN = new Set(['top', 'htop', 'btop', 'watch', 'tmux', 'screen']);
const REPLS = new Set([
  'python',
  'python3',
  'node',
  'irb',
  'ghci',
  'psql',
  'mysql',
  'sqlite3',
  'redis-cli',
  'mongosh',
  'bash',
  'zsh',
  'sh',
]);

function interactiveReason(cmd: SimpleCommand): string | undefined {
  const [name = '', ...args] = cmd.words;
  const base = name.split('/').pop() ?? name;
  if (EDITORS.has(base))
    return `${base} is an interactive editor. Use the Edit or Write tools to change files.`;
  if (PAGERS.has(base))
    return `${base} waits for keyboard input. Read the file with Read, or pipe output through head/tail.`;
  if (FULLSCREEN.has(base))
    return `${base} runs full-screen. Use a one-shot command instead (e.g. "ps aux | head -20").`;
  // a REPL with no arguments (or only -i/--interactive) waits for typed input
  if (REPLS.has(base) && args.every((a) => a === '-i' || a === '--interactive')) {
    return `${base} with no script starts an interactive session. Pass a script or use -c/-e.`;
  }
  if (base === 'ssh' && args.filter((a) => !a.startsWith('-')).length <= 1) {
    return 'ssh without a remote command opens an interactive session. Add the command to run.';
  }
  if (
    base === 'git' &&
    args.some((a) => a === '-i' || a === '--interactive' || a === '-p' || a === '--patch')
  ) {
    return 'Interactive git options (-i/-p) need a terminal. Use the non-interactive form.';
  }
  return undefined;
}

/** Returns why a command would hang waiting for a human, or `undefined` if it looks safe to run. */
export function interactiveCommandReason(command: string): string | undefined {
  for (const cmd of splitCommands(command)) {
    const reason = interactiveReason(cmd);
    if (reason !== undefined) return reason;
  }
  return undefined;
}

export function createBashTools(shell: ShellInfo): AnyTool[] {
  const bash = defineTool({
    name: 'Bash',
    description: [
      `Run a command in ${shell.label}. The working directory carries over between calls. Commands time out after 2 minutes by default (max 10).`,
      'Use it for builds, tests, git and other programs. Prefer Read/Glob/Grep/LS for looking at files instead of cat/find/grep/ls.',
      'Interactive programs (editors, pagers, REPLs) are refused. Quote paths that contain spaces. Set run_in_background for servers or watchers, then use BashOutput.',
    ].join(' '),
    input: z.object({
      command: z.string().min(1),
      description: z.string().optional().describe('5–10 words saying what the command does'),
      timeout: z
        .number()
        .int()
        .positive()
        .max(MAX_TIMEOUT_MS)
        .optional()
        .describe('Timeout in milliseconds'),
      run_in_background: z.boolean().optional(),
    }),
    kind: 'execute',
    readOnly: false,
    label: (i) => i.command,
    target: (i) => ({ command: i.command }),
    async run(i, ctx) {
      const refusal = interactiveCommandReason(i.command);
      if (refusal !== undefined)
        return {
          ok: false,
          content: `Not run: ${refusal}`,
          summary: 'Refused: interactive command',
        };
      if (i.run_in_background === true) {
        const id = ctx.shell.startBackground(i.command);
        return {
          ok: true,
          content: `Started in the background as ${id}. Read its output with BashOutput({"id":"${id}"}); stop it with KillBash.`,
          summary: `Started ${id} in the background`,
        };
      }
      const r = await ctx.shell.run(i.command, {
        timeoutMs: i.timeout ?? DEFAULT_TIMEOUT_MS,
        signal: ctx.signal,
        ...(ctx.onProgress ? { onOutput: ctx.onProgress } : {}),
      });
      const secs = (r.durationMs / 1000).toFixed(1);
      const notes: string[] = [];
      if (r.timedOut)
        notes.push(
          `[timed out after ${String(Math.round((i.timeout ?? DEFAULT_TIMEOUT_MS) / 1000))}s]`,
        );
      if (r.interrupted) notes.push('[interrupted by the user]');
      if (r.exitCode !== undefined && r.exitCode !== 0)
        notes.push(`[exit code ${String(r.exitCode)}]`);
      const body = r.output.trim() === '' ? '(no output)' : r.output.replace(/\s+$/, '');
      const content = truncateMiddle(
        `${body}${notes.length === 0 ? '' : `\n${notes.join('\n')}`}`,
        undefined,
        'pipe through head/tail or grep to narrow it',
      );
      const lines = countLines(r.output);
      const status = r.timedOut
        ? 'Timed out'
        : r.interrupted
          ? 'Interrupted'
          : `Exit ${String(r.exitCode ?? '?')}`;
      return {
        ok: r.exitCode === 0 && !r.timedOut && !r.interrupted,
        content,
        summary: `${status} · ${String(lines)} line${lines === 1 ? '' : 's'} · ${secs}s`,
      };
    },
  });

  const output = defineTool({
    name: 'BashOutput',
    description:
      'Read new output from a background command started with run_in_background, and whether it has finished.',
    input: z.object({ id: z.string() }),
    kind: 'meta',
    readOnly: true,
    label: (i) => i.id,
    target: () => ({}),
    run(i, ctx) {
      const r = ctx.shell.readJob(i.id);
      if (!r)
        return Promise.resolve({
          ok: false,
          content: `No background job ${i.id}.`,
          summary: 'Unknown job',
        });
      const status = r.done
        ? `finished with exit code ${String(r.exitCode ?? '?')}`
        : 'still running';
      return Promise.resolve({
        ok: true,
        content: truncateMiddle(
          `${r.output === '' ? '(no new output)' : r.output}\n[${i.id} ${status}]`,
        ),
        summary: `${String(countLines(r.output))} new lines · ${status}`,
      });
    },
  });

  const kill = defineTool({
    name: 'KillBash',
    description: 'Stop a background command started with run_in_background.',
    input: z.object({ id: z.string() }),
    kind: 'meta',
    readOnly: false,
    label: (i) => i.id,
    target: () => ({}),
    run(i, ctx) {
      const killed = ctx.shell.killJob(i.id);
      return Promise.resolve({
        ok: killed,
        content: killed ? `Stopped ${i.id}.` : `${i.id} is not running.`,
        summary: killed ? 'Stopped' : 'Not running',
      });
    },
  });

  return [bash, output, kill];
}
