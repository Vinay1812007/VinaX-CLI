import { execFile } from 'node:child_process';
import os from 'node:os';
import type { PermissionMode } from '../config/schema.js';

export interface GitInfo {
  branch: string;
  /** Short status (first 20 lines of `git status --short`), or "(clean)". */
  status: string;
  /** Commits ahead of / behind the upstream branch, when there is one. */
  upstream?: { name: string; ahead: number; behind: number };
  /** Paths with staged changes, unstaged changes and untracked paths (capped lists). */
  staged: string[];
  unstaged: string[];
  untracked: string[];
  /** Total counts, since the lists are capped. */
  counts: { staged: number; unstaged: number; untracked: number };
  /** `hash subject` of the latest commits, newest first. */
  recentCommits: string[];
}

const STATUS_LINES = 20;
const FILES_PER_LIST = 12;
const RECENT_COMMITS = 5;

function git(args: string[], cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 3000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? undefined : stdout.replace(/\s+$/, ''));
    });
  });
}

/** Parses `git status --porcelain=v1 --branch` output. */
export function parseGitStatus(porcelain: string): Omit<GitInfo, 'recentCommits' | 'status'> & {
  lines: string[];
} {
  const rows = porcelain.split('\n').filter((l) => l !== '');
  const head = rows[0]?.startsWith('## ') === true ? rows.shift()?.slice(3) : undefined;
  let branch = 'HEAD';
  let upstream: GitInfo['upstream'];
  if (head !== undefined) {
    const m =
      /^(?:No commits yet on |Initial commit on )?(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/.exec(head);
    branch = m?.[1] ?? head;
    if (m?.[2] !== undefined) {
      const info = m[3] ?? '';
      upstream = {
        name: m[2],
        ahead: Number(/ahead (\d+)/.exec(info)?.[1] ?? 0),
        behind: Number(/behind (\d+)/.exec(info)?.[1] ?? 0),
      };
    }
  }
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  for (const row of rows) {
    const x = row[0] ?? ' ';
    const y = row[1] ?? ' ';
    const file = row.slice(3);
    if (x === '?' && y === '?') untracked.push(file);
    else {
      if (x !== ' ') staged.push(file);
      if (y !== ' ') unstaged.push(file);
    }
  }
  return {
    branch,
    ...(upstream === undefined ? {} : { upstream }),
    staged: staged.slice(0, FILES_PER_LIST),
    unstaged: unstaged.slice(0, FILES_PER_LIST),
    untracked: untracked.slice(0, FILES_PER_LIST),
    counts: { staged: staged.length, unstaged: unstaged.length, untracked: untracked.length },
    lines: rows,
  };
}

/**
 * Branch, upstream, changed files and recent commits, or `undefined` outside a git repository.
 * Two quick git calls; every list is capped so a huge working tree cannot flood the prompt.
 */
export async function readGitInfo(cwd: string): Promise<GitInfo | undefined> {
  const [porcelain, log] = await Promise.all([
    git(['status', '--porcelain=v1', '--branch'], cwd),
    git(['log', `-${String(RECENT_COMMITS)}`, '--format=%h %s', '--no-color'], cwd),
  ]);
  if (porcelain === undefined) return undefined;
  const { lines, ...parsed } = parseGitStatus(porcelain);
  const shown = lines.slice(0, STATUS_LINES).join('\n');
  return {
    ...parsed,
    status:
      lines.length === 0
        ? '(clean)'
        : lines.length > STATUS_LINES
          ? `${shown}\n… ${String(lines.length - STATUS_LINES)} more`
          : shown,
    recentCommits: log === undefined || log === '' ? [] : log.split('\n'),
  };
}

/** The git part of the environment section. */
export function gitSection(info: GitInfo | undefined): string {
  if (info === undefined) return '- Git: not a git repository';
  const indent = (text: string): string =>
    text
      .split('\n')
      .map((l) => `    ${l}`)
      .join('\n');
  const out = [`- Git branch: ${info.branch}`];
  if (info.upstream !== undefined) {
    const { name, ahead, behind } = info.upstream;
    out.push(
      `- Upstream: ${name}${ahead + behind === 0 ? ' (up to date)' : ` (ahead ${String(ahead)}, behind ${String(behind)})`}`,
    );
  }
  const { staged, unstaged, untracked } = info.counts;
  out.push(
    `- Changes: ${String(staged)} staged, ${String(unstaged)} unstaged, ${String(untracked)} untracked`,
  );
  out.push(`- Git status:\n${indent(info.status)}`);
  if (info.recentCommits.length > 0)
    out.push(`- Recent commits:\n${indent(info.recentCommits.join('\n'))}`);
  return out.join('\n');
}

export interface PromptEnvironment {
  cwd: string;
  shell: string;
  date: string;
  git: GitInfo | undefined;
  /** Project and user instructions (VINAX.md etc.), when present. */
  memory?: string;
  /** The skills section (names and descriptions), when any skills are installed. */
  skills?: string;
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

# Git
- The environment section shows the branch, changed files and recent commits as of session start; run git again for the current state.
- "Review my changes": read \`git diff\` and \`git diff --staged\`, then report bugs and risks by file:line, most serious first.
- "Commit": check \`git status\` and the diff, stage only files that belong to the change, and write a concise message in the style of the recent commits. Never commit or push unless the user asked.
- "Explain this diff": describe what changed and why it matters, not line-by-line restatements.
- Never rewrite published history, force-push or discard changes unless the user explicitly asked.

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
  const sections = [
    CORE,
    ...(mode === 'plan' ? [PLAN_MODE] : []),
    [
      '# Environment',
      `- Project root: ${env.cwd}`,
      `- Platform: ${os.type()} ${os.release()} (${process.platform}/${process.arch})`,
      `- Shell for the Bash tool: ${env.shell}`,
      `- Date: ${env.date}`,
      gitSection(env.git),
    ].join('\n'),
    ...(env.memory === undefined || env.memory.trim() === ''
      ? []
      : [`# Project instructions\n${env.memory.trim()}`]),
    ...(env.skills === undefined ? [] : [env.skills]),
    ...(toolInstructions === undefined ? [] : [toolInstructions]),
  ];
  return sections.join('\n\n');
}
