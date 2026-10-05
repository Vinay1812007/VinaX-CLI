import fs from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';
import {
  defaultWorktreeName,
  findRepoRoot,
  WORKTREE_NOT_A_SANDBOX,
  WorktreeError,
  WorktreeManager,
  type WorktreeFileChange,
  type WorktreeInfo,
} from '@vinax/core';
import { EXIT } from './exit-codes.js';
import { paint, type CliIO } from './io.js';

function changeLines(files: readonly WorktreeFileChange[]): string[] {
  return files.map(
    (f) => `  ${f.path}  ${f.binary ? '(binary)' : `+${String(f.added)} −${String(f.removed)}`}`,
  );
}

/** What to do next with a worktree, as commands to copy. */
export function worktreeNextSteps(name: string): string[] {
  return [
    `  review:   vinax worktree diff ${name}`,
    `  apply:    vinax worktree apply ${name}   (copies the changes into your checkout)`,
    `  discard:  vinax worktree remove ${name} --force`,
  ];
}

async function manager(io: CliIO): Promise<WorktreeManager> {
  const repo = await findRepoRoot(io.cwd);
  if (repo === undefined)
    throw new WorktreeError('Worktrees need a git repository; this folder is not inside one.');
  return new WorktreeManager(repo, io.env);
}

/**
 * Opens (or creates) the worktree for `--worktree` and returns the folder to work in: the same
 * subfolder of the worktree as the one VinaX was started from.
 */
export async function enterWorktree(
  io: CliIO,
  name: string | true,
): Promise<{ info: WorktreeInfo; cwd: string; created: boolean }> {
  const m = await manager(io);
  const { info, created } = await m.open(name === true ? defaultWorktreeName() : name);
  // compare real paths: git reports the repository's real path (e.g. /private/var on macOS)
  const rel = path.relative(await fs.realpath(m.repo), await fs.realpath(io.cwd));
  const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  return { info, cwd: inside ? path.join(info.path, rel) : info.path, created };
}

/** The lines shown when a session starts in a worktree. */
export function worktreeBanner(info: WorktreeInfo, created: boolean): string {
  return `${created ? 'Created' : 'Using'} worktree ${info.name} (branch ${info.branch}) at ${info.path}. Your checkout is not changed until you apply it. ${WORKTREE_NOT_A_SANDBOX}`;
}

export function worktreeCommand(io: CliIO, setExit: (code: number) => void): Command {
  const out = (s: string) => io.stdout.write(`${s}\n`);
  const err = (s: string) => io.stderr.write(`${s}\n`);
  const fail = (e: unknown): void => {
    err(paint(io.stderr, 'red', e instanceof Error ? e.message : String(e), io.env));
    setExit(EXIT.error);
  };
  const cmd = new Command('worktree').description(
    'Isolated git worktrees for VinaX tasks: start one with vinax --worktree [name], then review, apply or remove it',
  );

  cmd
    .command('list')
    .description('List VinaX worktrees of this repository and whether they have changes')
    .action(async () => {
      try {
        const m = await manager(io);
        const all = await m.list();
        if (all.length === 0) {
          out('No VinaX worktrees. Start one with: vinax --worktree [name]');
          return;
        }
        for (const w of all) {
          const c = await m.changes(w.name).catch(() => undefined);
          const state =
            c === undefined
              ? 'folder missing'
              : c.files.length === 0
                ? 'no changes'
                : `${String(c.files.length)} file${c.files.length === 1 ? '' : 's'} changed${w.applied?.hash === c.hash ? ' · applied' : ''}`;
          out(`${w.name}  ${w.branch}  ${state}\n  ${w.path}`);
        }
      } catch (e) {
        fail(e);
      }
    });

  cmd
    .command('diff <name>')
    .description('Show everything the worktree changed (commits, edits and new files)')
    .option('--stat', 'only list the files with lines added and removed')
    .action(async (name: string, o: { stat?: boolean }) => {
      try {
        const c = await (await manager(io)).changes(name);
        if (c.files.length === 0) {
          out(`Worktree ${name} has no changes.`);
          return;
        }
        if (o.stat === true) for (const l of changeLines(c.files)) out(l);
        else io.stdout.write(c.patch);
      } catch (e) {
        fail(e);
      }
    });

  cmd
    .command('apply <name>')
    .description(
      'Copy the worktree’s changes into your checkout; nothing is written unless all of it applies cleanly',
    )
    .action(async (name: string) => {
      try {
        const r = await (await manager(io)).apply(name);
        if (r.status === 'nothing') {
          out(`Worktree ${name} has no changes to apply.`);
          return;
        }
        if (r.status === 'conflict') {
          err(
            [
              `Not applied: the changes conflict with your checkout, so nothing was written.`,
              r.detail,
              `The patch is saved at ${r.patchFile}. Commit or stash your own changes and try again, or apply it with: git apply --3way ${r.patchFile}`,
            ].join('\n'),
          );
          setExit(EXIT.error);
          return;
        }
        out(
          `Applied ${String(r.files.length)} file${r.files.length === 1 ? '' : 's'} from ${name} to your checkout (not staged or committed).`,
        );
        if (r.dirtyElsewhere.length > 0)
          out(
            `Your uncommitted changes in ${String(r.dirtyElsewhere.length)} other file${r.dirtyElsewhere.length === 1 ? '' : 's'} were left as they were.`,
          );
        out(`When you are done with it: vinax worktree remove ${name}`);
      } catch (e) {
        fail(e);
      }
    });

  cmd
    .command('remove <name>')
    .description(
      'Delete the worktree and its branch (refuses if it has changes you have not applied)',
    )
    .option('--force', 'discard changes that were never applied')
    .action(async (name: string, o: { force?: boolean }) => {
      try {
        const r = await (await manager(io)).remove(name, { force: o.force === true });
        if (r.status === 'unapplied') {
          err(
            [
              `Not removed: worktree ${name} has changes you have not applied:`,
              ...changeLines(r.files),
              ...worktreeNextSteps(name),
            ].join('\n'),
          );
          setExit(EXIT.error);
          return;
        }
        out(
          r.discarded === 0
            ? `Removed worktree ${name}.`
            : `Removed worktree ${name} and discarded changes to ${String(r.discarded)} file${r.discarded === 1 ? '' : 's'}.`,
        );
      } catch (e) {
        fail(e);
      }
    });
  return cmd;
}
