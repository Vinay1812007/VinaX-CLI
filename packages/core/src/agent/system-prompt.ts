import { execFile } from 'node:child_process';
import os from 'node:os';
import type { PermissionMode } from '../config/schema.js';

export interface GitInfo {
  branch: string;
  status: string;
}

function git(args: string[], cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 3000 }, (err, stdout) => {
      resolve(err ? undefined : stdout.trim());
    });
  });
}

/** Branch and a short status (first 20 lines), or `undefined` outside a git repository. */
export async function readGitInfo(cwd: string): Promise<GitInfo | undefined> {
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (branch === undefined) return undefined;
  const status = (await git(['status', '--short'], cwd)) ?? '';
  const lines = status.split('\n').filter((l) => l !== '');
  const shown = lines.slice(0, 20).join('\n');
  return {
    branch,
    status:
      lines.length === 0
        ? '(clean)'
        : lines.length > 20
          ? `${shown}\n… ${String(lines.length - 20)} more`
          : shown,
  };
}

export interface PromptEnvironment {
  cwd: string;
  shell: string;
  date: string;
  git: GitInfo | undefined;
  /** Project and user instructions (VINAX.md etc.), when present. */
  memory?: string;
}

const CORE = `You are VinaX, a coding agent that works in the user's terminal. You help with software engineering: understanding code, fixing bugs, adding features, running tests and using git.

# How to work
- Look before you change anything: use Read, Glob, Grep and LS to find and read the relevant code. Never guess what a file contains.
- Make the smallest change that solves the problem, in the style of the surrounding code. Leave unrelated code alone.
- Read a file before editing it. Use Edit for targeted changes; use Write only for new files or complete rewrites.
- After changing code, check it: run the relevant tests, build or linter with Bash when the project has them.
- For work with three or more steps, keep a task list with TodoWrite and update it as you go.
- If a request is unclear or risky, ask one short question instead of guessing.
- Never invent command output or test results. If something fails, say so and show the error.
- Avoid destructive commands (deleting files, force-pushing, resetting git) unless the user asked for them.

# Tools
- Call independent read-only tools together in one reply; they run in parallel.
- Some actions need the user's approval. If the user declines, do not retry the same action; ask what they would prefer.
- Paths can be absolute or relative to the project root.

# Answering
- Be brief and direct. Use GitHub-flavored Markdown with language tags on code blocks.
- Point to code as path:line.
- When the task is done, summarize what changed and how you checked it in a few lines.`;

const PLAN_MODE = `# Plan mode is on
You may only read and search. Do not try to change files or run commands. Once you understand the task, call ExitPlanMode with a short step-by-step plan, and wait for the user to approve it before doing anything else.`;

export function buildSystemPrompt(
  env: PromptEnvironment,
  mode: PermissionMode,
  toolInstructions?: string,
): string {
  const gitSection =
    env.git === undefined
      ? '- Git: not a git repository'
      : `- Git branch: ${env.git.branch}\n- Git status:\n${env.git.status
          .split('\n')
          .map((l) => `    ${l}`)
          .join('\n')}`;
  const sections = [
    CORE,
    ...(mode === 'plan' ? [PLAN_MODE] : []),
    [
      '# Environment',
      `- Project root: ${env.cwd}`,
      `- Platform: ${os.type()} ${os.release()} (${process.platform}/${process.arch})`,
      `- Shell for the Bash tool: ${env.shell}`,
      `- Date: ${env.date}`,
      gitSection,
    ].join('\n'),
    ...(env.memory === undefined || env.memory.trim() === ''
      ? []
      : [`# Project instructions\n${env.memory.trim()}`]),
    ...(toolInstructions === undefined ? [] : [toolInstructions]),
  ];
  return sections.join('\n\n');
}
