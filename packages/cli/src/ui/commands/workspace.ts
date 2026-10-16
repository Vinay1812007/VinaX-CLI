import fs from 'node:fs';
import { resolvePath, type ToolKind } from '@vinax/core';
import { shortenPath } from '../format.js';
import type { SlashCommand } from './types.js';

const KIND_LABELS: Record<ToolKind, string> = {
  read: 'reads',
  edit: 'changes files',
  execute: 'runs commands',
  network: 'web',
  meta: 'VinaX',
};

/** First sentence of a tool description, for a one-line listing. */
function firstSentence(text: string): string {
  const m = /^(.+?[.!?])(\s|$)/s.exec(text.trim());
  const s = (m?.[1] ?? text).replace(/\s+/g, ' ').trim();
  return s.length > 140 ? `${s.slice(0, 137)}…` : s;
}

/** `/tools`: every tool the model can call now, built-in and MCP (Gemini CLI's /tools). */
export const toolsCommand: SlashCommand = {
  name: 'tools',
  overridable: true,
  description: 'List the tools VinaX can use (add "desc" for descriptions)',
  argumentHint: '[desc]',
  source: 'builtin',
  run(ctx) {
    const full = /^(desc|descriptions|-d|--desc)$/i.test(ctx.args.trim());
    const tools = ctx.setup.tools;
    const builtin = tools.filter((t) => !t.name.startsWith('mcp__'));
    const mcp = tools.filter((t) => t.name.startsWith('mcp__'));
    const line = (t: (typeof tools)[number]) =>
      `- \`${t.name}\` _(${KIND_LABELS[t.kind]}${t.readOnly ? ', read-only' : ''})_${full ? ` — ${firstSentence(t.description)}` : ''}`;
    ctx.panel(
      `Tools (${String(tools.length)})`,
      [
        ...builtin.map(line),
        ...(mcp.length === 0 ? [] : ['', '**MCP**', ...mcp.map(line)]),
        '',
        full ? 'Manage MCP servers with `/mcp`.' : 'Type `/tools desc` for descriptions.',
      ].join('\n'),
    );
  },
};

/**
 * `/directory add <path>` (Gemini CLI) and `/add-dir <path>` (Claude Code): let tools read and
 * write another folder for the rest of the session, like `--add-dir`.
 */
export const directoryCommand: SlashCommand = {
  name: 'directory',
  overridable: true,
  aliases: ['dir', 'add-dir'],
  description: 'Show the folders tools may use, or add one for this session',
  argumentHint: '[add <path> | show]',
  source: 'builtin',
  run(ctx) {
    const raw = ctx.args.trim();
    // `/add-dir x` and `/directory add x` both add; `/directory` alone shows the list
    const m = /^add\s+([\s\S]+)$/i.exec(raw);
    const target = m?.[1]?.trim() ?? (raw === '' || /^(show|list)$/i.test(raw) ? undefined : raw);
    if (target === undefined) {
      ctx.panel(
        'Workspace folders',
        [
          ...ctx.setup.workspace.map((w) => `- \`${shortenPath(w)}\``),
          '',
          'Add one with `/directory add <path>` (this session) or `--add-dir <path>` / `permissions.additionalDirectories` in settings.',
        ].join('\n'),
      );
      return;
    }
    const added: string[] = [];
    for (const one of target
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')) {
      const abs = resolvePath(one, ctx.runtime.cwd);
      let isDir = false;
      try {
        isDir = fs.statSync(abs).isDirectory();
      } catch {
        // missing
      }
      if (!isDir) {
        ctx.notice('error', `${shortenPath(abs)} is not a folder.`);
        continue;
      }
      const result = ctx.setup.addDirectory(abs);
      if (result === undefined)
        ctx.notice('info', `${shortenPath(abs)} is already in the workspace.`);
      else added.push(shortenPath(result));
    }
    if (added.length > 0)
      ctx.notice(
        'info',
        `Tools may now read and change files in ${added.join(', ')} for this session.`,
      );
  },
};

/** What `/review` asks for: a code review of local changes, a branch or a GitHub PR. */
export function reviewPrompt(args: string): string {
  const target = args.trim();
  const pr = /^#?(\d+)$/.exec(target)?.[1];
  const what =
    pr !== undefined
      ? `pull request #${pr}. Read it with \`gh pr view ${pr}\` and \`gh pr diff ${pr}\` (GitHub CLI); if gh is missing or not logged in, say so and stop`
      : target !== ''
        ? `the changes on \`${target}\` compared with the branch it forked from (\`git diff $(git merge-base HEAD ${target})...${target}\` or \`git diff ${target}\` for a path)`
        : 'my uncommitted changes (`git status`, `git diff` and `git diff --staged`; if there are none, the last commit with `git show HEAD`)';
  return [
    `Review ${what}.`,
    'Read surrounding code where you need context. Report, most serious first:',
    '- bugs and behaviour regressions, with file:line and a concrete failing case;',
    '- security problems (injection, secrets, unsafe input handling);',
    '- missing tests for the risky parts, and anything that breaks existing callers.',
    'Skip style nits that a formatter or linter would catch. Do not change any files — this is a review only. End with a one-line verdict.',
  ].join('\n');
}

/** `/review [pr-number | branch | path]` (Claude Code and Codex CLI). */
export const reviewCommand: SlashCommand = {
  name: 'review',
  overridable: true,
  description: 'Review uncommitted changes, a branch, or a GitHub pull request',
  argumentHint: '[pr-number | branch]',
  source: 'builtin',
  run(ctx) {
    const args = ctx.args.trim();
    ctx.send(reviewPrompt(args), {
      display: `/review${args === '' ? '' : ` ${args}`}`,
      allowRules: REVIEW_TOOLS,
    });
  },
};

const REVIEW_TOOLS = [
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'Bash(git show:*)',
  'Bash(git log:*)',
  'Bash(git merge-base:*)',
  'Bash(gh pr view:*)',
  'Bash(gh pr diff:*)',
];

/** What `/security-review` asks for (Claude Code's /security-review). */
export function securityReviewPrompt(args: string): string {
  const target = args.trim();
  return [
    `Do a security review of ${target === '' ? 'my uncommitted changes (`git diff` and `git diff --staged`; if there are none, the last commit with `git show HEAD`)' : `\`${target}\``}.`,
    'Look for injection (SQL, shell, path traversal, template), authentication and authorisation gaps, secrets or keys in code, unsafe deserialisation, SSRF, XSS, missing input validation, insecure defaults and vulnerable dependency use.',
    'For each finding give the severity (high/medium/low), file:line, how it could be exploited and a concrete fix. Report only real, reachable problems, most serious first; say plainly if you found none.',
    'Do not change any files — this is a review only.',
  ].join('\n');
}

/** What `/pr-comments` asks for: the review comments on a GitHub pull request. */
export function prCommentsPrompt(args: string): string {
  const pr = /^#?(\d+)$/.exec(args.trim())?.[1];
  const which =
    pr === undefined ? 'the pull request for the current branch' : `pull request #${pr}`;
  const ref = pr === undefined ? '' : ` ${pr}`;
  return [
    `Show the review comments on ${which} using the GitHub CLI: \`gh pr view${ref} --comments\` for the conversation, and \`gh api repos/{owner}/{repo}/pulls/<number>/comments\` for inline comments (find the number with \`gh pr view${ref} --json number\`).`,
    'Summarise them grouped by file, with the file:line, who said it and what they asked for, and mark which ones still need a change. If gh is missing or not logged in, say so and stop. Do not change any files.',
  ].join('\n');
}

export const securityReviewCommand: SlashCommand = {
  name: 'security-review',
  overridable: true,
  description: 'Security review of uncommitted changes or a path',
  argumentHint: '[path]',
  source: 'builtin',
  run(ctx) {
    const args = ctx.args.trim();
    ctx.send(securityReviewPrompt(args), {
      display: `/security-review${args === '' ? '' : ` ${args}`}`,
      allowRules: REVIEW_TOOLS,
    });
  },
};

export const prCommentsCommand: SlashCommand = {
  name: 'pr-comments',
  overridable: true,
  description: 'Show the review comments on a GitHub pull request',
  argumentHint: '[pr-number]',
  source: 'builtin',
  run(ctx) {
    const args = ctx.args.trim();
    ctx.send(prCommentsPrompt(args), {
      display: `/pr-comments${args === '' ? '' : ` ${args}`}`,
      allowRules: ['Bash(gh pr view:*)'],
    });
  },
};

const TODO_ICONS = { pending: '☐', in_progress: '◐', completed: '☑' } as const;

/** `/todos`: the task list the agent keeps with TodoWrite. */
export const todosCommand: SlashCommand = {
  name: 'todos',
  overridable: true,
  description: "Show the agent's current task list",
  source: 'builtin',
  run(ctx) {
    const todos = ctx.setup.todos.todos;
    ctx.panel(
      'Tasks',
      todos.length === 0
        ? 'No tasks yet. VinaX keeps a task list for work with three or more steps.'
        : todos.map((t) => `- ${TODO_ICONS[t.status]} ${t.content}`).join('\n'),
    );
  },
};

/** `/bashes`: background commands started this session (Claude Code's /bashes). */
export const bashesCommand: SlashCommand = {
  name: 'bashes',
  overridable: true,
  aliases: ['jobs'],
  description: 'List background commands; "/bashes kill <id>" stops one',
  argumentHint: '[kill <id>]',
  source: 'builtin',
  run(ctx) {
    const kill = /^kill\s+(\S+)$/i.exec(ctx.args.trim())?.[1];
    if (kill !== undefined) {
      const stopped = ctx.setup.shell.killJob(kill);
      ctx.notice(
        stopped ? 'info' : 'warning',
        stopped ? `Stopped ${kill}.` : `${kill} is not running.`,
      );
      return;
    }
    const jobs = ctx.setup.shell.listJobs();
    ctx.panel(
      'Background commands',
      jobs.length === 0
        ? 'No background commands in this session.'
        : jobs
            .map(
              (j) =>
                `- \`${j.id}\` ${j.done ? `finished (exit ${String(j.exitCode ?? '?')})` : '**running**'} — \`${j.command}\``,
            )
            .join('\n'),
    );
  },
};
