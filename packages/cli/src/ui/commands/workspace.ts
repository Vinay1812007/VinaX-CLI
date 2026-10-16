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
      allowRules: [
        'Bash(git status:*)',
        'Bash(git diff:*)',
        'Bash(git show:*)',
        'Bash(git log:*)',
        'Bash(git merge-base:*)',
        'Bash(gh pr view:*)',
        'Bash(gh pr diff:*)',
      ],
    });
  },
};
