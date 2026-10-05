import { Box, Text, useInput } from 'ink';
import { useEffect, useState, type ReactNode } from 'react';
import {
  diffDisplay,
  displayPath,
  type ConflictResolution,
  type RestoreFilePlan,
  type RestorePlan,
} from '@vinax/core';
import { truncate } from '../format.js';
import { useTheme } from '../theme.js';
import { DiffView } from './DiffView.js';
import { Select } from './Select.js';

export interface RewindTarget {
  turn: number;
  prompt: string;
  /** Files VinaX changed from this turn on (restorable). */
  changedFiles: number;
  /** Shell commands VinaX ran from this turn on; their effects cannot be undone. */
  shellCommands: number;
}

export interface RewindChoice {
  turn: number;
  conversation: boolean;
  code: boolean;
  /** What to do with files changed outside VinaX (`abort` when there were none). */
  resolution: ConflictResolution;
}

type Action = 'both' | 'conversation' | 'code' | 'cancel';
type Resolve = 'keep' | 'overwrite' | 'diff' | 'cancel';

const plural = (n: number, word: string): string => `${String(n)} ${word}${n === 1 ? '' : 's'}`;

/** "+3 −1": what restoring does to a file's current content. */
export function restoreDelta(f: RestoreFilePlan): string {
  if (f.current === undefined) return 'unreadable';
  if (f.target === null) return 'would be deleted';
  if (f.current === null) return 'would be recreated';
  const d = diffDisplay(f.file, f.current, f.target, false);
  return d.kind === 'diff' ? `+${String(d.added)} −${String(d.removed)} on restore` : '';
}

/** The lines restoring would remove (−) and bring back (+). */
function ConflictDiff({ plan, width }: { plan: RestoreFilePlan; width: number }) {
  if (typeof plan.current !== 'string') return null;
  const d = diffDisplay(plan.file, plan.current, plan.target ?? '', false);
  if (d.kind !== 'diff') return null;
  return (
    <Box paddingLeft={3}>
      <DiffView diff={d} maxLines={12} width={width} />
    </Box>
  );
}

function ShellCaveat({ count }: { count: number }) {
  const theme = useTheme();
  if (count === 0)
    return (
      <Text color={theme.muted}>
        Only changes made with VinaX&apos;s file tools can be restored, not changes made by
        commands.
      </Text>
    );
  return (
    <Text color={theme.warning}>
      ⚠ {plural(count, 'shell command')} ran since then. Their effects (installs, generated or
      deleted files, git operations) are not checkpointed and will not be undone.
    </Text>
  );
}

/**
 * Esc Esc: pick an earlier prompt, then what to restore. When files changed outside VinaX since
 * it wrote them, the picker lists them and asks before anything of the user's is overwritten.
 */
export function RewindPicker({
  targets,
  width,
  cwd,
  plan,
  onDone,
}: {
  targets: readonly RewindTarget[];
  width: number;
  cwd: string;
  /** What restoring files to before a turn would do (read from disk when asked). */
  plan: (turn: number) => Promise<RestorePlan>;
  onDone: (choice: RewindChoice | undefined) => void;
}) {
  const theme = useTheme();
  const [picked, setPicked] = useState<RewindTarget | undefined>(undefined);
  const [action, setAction] = useState<Exclude<Action, 'cancel'> | undefined>(undefined);
  const [restorePlan, setRestorePlan] = useState<RestorePlan | undefined>(undefined);
  const [showDiff, setShowDiff] = useState(false);
  useInput((_input, key) => {
    if (key.escape) onDone(undefined);
  });

  const wantsCode = action === 'both' || action === 'code';
  useEffect(() => {
    if (picked === undefined || !wantsCode) return;
    let live = true;
    void plan(picked.turn).then((p) => {
      if (!live) return;
      if (p.conflicts.length === 0)
        onDone({
          turn: picked.turn,
          conversation: action === 'both',
          code: true,
          resolution: 'abort',
        });
      else setRestorePlan(p);
    });
    return () => {
      live = false;
    };
  }, [picked, action]);

  const box = (children: ReactNode) => (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={1}
      marginTop={1}
    >
      {children}
    </Box>
  );

  if (picked === undefined) {
    const newestFirst = [...targets].reverse();
    return box(
      <>
        <Text bold>Rewind to before which prompt?</Text>
        <Text color={theme.muted}>
          The conversation and/or files go back to how they were before it. Esc to cancel.
        </Text>
        <Box marginTop={1}>
          <Select
            items={newestFirst.map((t) => ({
              label: truncate(t.prompt, width - 30),
              value: t,
              hint: [
                t.changedFiles === 0 ? '' : `${plural(t.changedFiles, 'file')} changed since`,
                t.shellCommands === 0 ? '' : plural(t.shellCommands, 'command'),
              ]
                .filter((s) => s !== '')
                .join(' · '),
            }))}
            onSelect={setPicked}
          />
        </Box>
      </>,
    );
  }

  if (action === undefined) {
    return box(
      <>
        <Text bold>Rewind to before “{truncate(picked.prompt, width - 30)}”</Text>
        <Box marginTop={1}>
          <Select<Action>
            items={[
              ...(picked.changedFiles > 0
                ? [
                    {
                      label: `Restore the conversation and ${String(picked.changedFiles)} changed file(s)`,
                      value: 'both' as const,
                    },
                  ]
                : []),
              { label: 'Restore the conversation only', value: 'conversation' },
              ...(picked.changedFiles > 0
                ? [{ label: 'Restore the files only', value: 'code' as const }]
                : []),
              { label: 'Cancel', value: 'cancel' },
            ]}
            onSelect={(a) => {
              if (a === 'cancel') onDone(undefined);
              else if (a === 'conversation')
                onDone({ turn: picked.turn, conversation: true, code: false, resolution: 'abort' });
              else setAction(a);
            }}
          />
        </Box>
        <ShellCaveat count={picked.shellCommands} />
      </>,
    );
  }

  if (restorePlan === undefined) return box(<Text color={theme.muted}>Checking the files…</Text>);

  const conflicts = restorePlan.conflicts;
  const others = restorePlan.files.filter((f) => f.status === 'clean' && f.action !== 'none');
  const keepLabel =
    others.length > 0
      ? `Keep my versions of ${plural(conflicts.length, 'file')}; restore the other ${String(others.length)}`
      : action === 'both'
        ? `Keep my versions; rewind only the conversation`
        : undefined;
  return box(
    <>
      <Text bold color={theme.warning}>
        {plural(conflicts.length, 'file')} changed outside VinaX since it edited{' '}
        {conflicts.length === 1 ? 'it' : 'them'}
      </Text>
      <Text color={theme.muted}>
        Restoring would discard those changes. Nothing has been changed yet.
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {conflicts.slice(0, 8).map((f) => (
          <Box key={f.file} flexDirection="column">
            <Text wrap="truncate-end">
              <Text color={theme.warning}>{f.status === 'modified' ? '✎ ' : '? '}</Text>
              {displayPath(f.file, cwd)}
              <Text color={theme.muted}> · {restoreDelta(f)}</Text>
            </Text>
            <Text color={theme.muted} wrap="truncate-end">
              {'   '}
              {f.reason ?? ''}
            </Text>
            {showDiff ? <ConflictDiff plan={f} width={width - 6} /> : null}
          </Box>
        ))}
        {conflicts.length > 8 ? (
          <Text color={theme.muted}>… and {String(conflicts.length - 8)} more</Text>
        ) : null}
      </Box>
      <Box marginTop={1}>
        <Select<Resolve>
          items={[
            ...(keepLabel === undefined ? [] : [{ label: keepLabel, value: 'keep' as const }]),
            {
              label: 'Overwrite them too (your current versions are backed up first)',
              value: 'overwrite',
            },
            {
              label: showDiff ? 'Hide the differences' : 'Show what restoring would change',
              value: 'diff',
            },
            { label: 'Cancel', value: 'cancel' },
          ]}
          onSelect={(r) => {
            if (r === 'cancel') onDone(undefined);
            else if (r === 'diff') setShowDiff((s) => !s);
            else
              onDone({
                turn: picked.turn,
                conversation: action === 'both',
                code: true,
                resolution: r,
              });
          }}
        />
      </Box>
      <ShellCaveat count={picked.shellCommands} />
    </>,
  );
}
