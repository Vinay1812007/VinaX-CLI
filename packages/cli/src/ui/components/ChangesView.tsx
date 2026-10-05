import { Box, Text, useInput } from 'ink';
import { useEffect, useState } from 'react';
import type { ConflictResolution } from '@vinax/core';
import { changeDiff, type ChangeRow } from '../changes.js';
import { padColumns, truncate } from '../format.js';
import { useTheme } from '../theme.js';
import { DiffView } from './DiffView.js';
import { Select } from './Select.js';

const KIND_MARK: Record<ChangeRow['kind'], string> = {
  created: 'A',
  deleted: 'D',
  modified: 'M',
  unchanged: '=',
  unreadable: '?',
};

const LIST_ROWS = 8;

interface Props {
  /** Reads the files again (after an undo, or on `r`). */
  load: () => Promise<ChangeRow[]>;
  /** Undoes one file; resolves with a one-line result for the user. */
  undo: (row: ChangeRow, resolution: ConflictResolution) => Promise<string>;
  width: number;
  height: number;
  onClose: () => void;
}

/**
 * Ctrl+G / `/changes`: the files VinaX changed this session with lines added and removed, the
 * diff of the selected file from before VinaX touched it, and undo per file. A file changed
 * outside VinaX is marked, and undoing it asks first.
 */
export function ChangesView({ load, undo, width, height, onClose }: Props) {
  const theme = useTheme();
  const [rows, setRows] = useState<ChangeRow[] | undefined>(undefined);
  const [index, setIndex] = useState(0);
  const [offset, setOffset] = useState(0);
  const [confirm, setConfirm] = useState<ChangeRow | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);

  const refresh = async (): Promise<void> => {
    const next = await load();
    setRows(next);
    setIndex((i) => Math.min(i, Math.max(0, next.length - 1)));
  };
  useEffect(() => {
    void refresh();
  }, []);

  const selected = rows?.[index];
  const diffRows = Math.max(4, height - Math.min(LIST_ROWS, rows?.length ?? 0) - 12);
  const page = Math.max(1, diffRows - 2);

  useInput(
    (input, key) => {
      if (key.escape || input === 'q' || (key.ctrl && input === 'g')) {
        onClose();
        return;
      }
      if (rows === undefined || rows.length === 0 || busy) return;
      if (key.upArrow || input === 'k') {
        setIndex((i) => (i - 1 + rows.length) % rows.length);
        setOffset(0);
      } else if (key.downArrow || input === 'j') {
        setIndex((i) => (i + 1) % rows.length);
        setOffset(0);
      } else if (key.pageDown || input === ' ' || input === ']') setOffset((o) => o + page);
      else if (key.pageUp || input === 'b' || input === '[')
        setOffset((o) => Math.max(0, o - page));
      else if (input === 'r') {
        setMessage(undefined);
        void refresh();
      } else if (input === 'u' && selected !== undefined && selected.kind !== 'unchanged') {
        setMessage(undefined);
        setConfirm(selected);
      }
    },
    { isActive: confirm === undefined },
  );

  useInput(
    (_input, key) => {
      if (key.escape) setConfirm(undefined);
    },
    { isActive: confirm !== undefined },
  );

  const doUndo = async (row: ChangeRow, resolution: ConflictResolution): Promise<void> => {
    setConfirm(undefined);
    setBusy(true);
    try {
      setMessage(await undo(row, resolution));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const total = (rows ?? []).reduce(
    (t, r) => ({ added: t.added + r.added, removed: t.removed + r.removed }),
    { added: 0, removed: 0 },
  );
  const first = Math.min(
    Math.max(0, index - Math.floor(LIST_ROWS / 2)),
    Math.max(0, (rows?.length ?? 0) - LIST_ROWS),
  );
  const nameWidth = Math.max(10, Math.min(width - 24, ...(rows ?? []).map((r) => r.shown.length)));

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={1}
      marginTop={1}
    >
      <Text bold>
        Changes this session
        {rows === undefined || rows.length === 0 ? null : (
          <Text color={theme.muted}>
            {' '}
            · {rows.length} file{rows.length === 1 ? '' : 's'} ·{' '}
            <Text color={theme.success}>+{total.added}</Text>{' '}
            <Text color={theme.error}>−{total.removed}</Text>
          </Text>
        )}
      </Text>
      {rows === undefined ? <Text color={theme.muted}>Reading files…</Text> : null}
      {rows !== undefined && rows.length === 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>No file changes to review yet.</Text>
          <Text color={theme.muted}>
            Files VinaX edits with its Edit, MultiEdit and Write tools appear here with their diffs
            and can be undone one by one. Changes made by shell commands are not tracked.
          </Text>
        </Box>
      ) : null}
      {rows !== undefined && rows.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {first > 0 ? <Text color={theme.muted}> ↑ {first} more</Text> : null}
          {rows.slice(first, first + LIST_ROWS).map((r, i) => {
            const at = first + i;
            const active = at === index;
            return (
              <Text key={r.file} wrap="truncate-end">
                <Text color={active ? theme.accent : theme.muted}>{active ? '› ' : '  '}</Text>
                <Text
                  color={
                    r.kind === 'deleted'
                      ? theme.error
                      : r.kind === 'created'
                        ? theme.success
                        : undefined
                  }
                >
                  {KIND_MARK[r.kind]}{' '}
                </Text>
                <Text bold={active}>{padColumns(truncate(r.shown, nameWidth), nameWidth)}</Text>
                <Text color={theme.success}> +{r.added}</Text>
                <Text color={theme.error}> −{r.removed}</Text>
                {r.status === 'clean' ? null : (
                  <Text color={theme.warning}>
                    {r.status === 'modified' ? '  ✎ changed outside VinaX' : '  ? not verified'}
                  </Text>
                )}
              </Text>
            );
          })}
          {first + LIST_ROWS < rows.length ? (
            <Text color={theme.muted}> ↓ {rows.length - first - LIST_ROWS} more</Text>
          ) : null}
        </Box>
      ) : null}
      {selected !== undefined && confirm === undefined ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.muted} wrap="truncate-end">
            {selected.shown} · since before turn {selected.firstTurn}
            {selected.reason === undefined ? '' : ` · ${selected.reason}`}
          </Text>
          {selected.kind === 'unchanged' ? (
            <Text color={theme.muted}>Back to its original content; nothing to undo.</Text>
          ) : selected.kind === 'unreadable' ? (
            <Text color={theme.warning}>The file cannot be read right now.</Text>
          ) : (
            <DiffView
              diff={changeDiff(selected)}
              maxLines={diffRows}
              width={width - 4}
              offset={offset}
              moreHint="PgDn/Space for more"
            />
          )}
        </Box>
      ) : null}
      {confirm !== undefined ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>
            Undo VinaX&apos;s changes to {confirm.shown}?{' '}
            <Text color={theme.muted}>
              It goes back to how it was before turn {confirm.firstTurn}
              {confirm.original === null ? ' (it did not exist, so it is deleted)' : ''}.
            </Text>
          </Text>
          {confirm.status === 'clean' ? null : (
            <Text color={theme.warning}>
              ⚠ {confirm.reason ?? 'It changed outside VinaX'}. Undoing discards that too; your
              current version is saved to a backup folder first.
            </Text>
          )}
          <Select<'yes' | 'no'>
            items={[
              {
                label:
                  confirm.status === 'clean'
                    ? 'Undo this file'
                    : 'Undo it anyway (backed up first)',
                value: 'yes',
              },
              { label: 'Cancel', value: 'no' },
            ]}
            onSelect={(v) => {
              if (v === 'no') setConfirm(undefined);
              else void doUndo(confirm, confirm.status === 'clean' ? 'abort' : 'overwrite');
            }}
          />
        </Box>
      ) : null}
      {message === undefined ? null : (
        <Text color={theme.accent} wrap="wrap">
          {message}
        </Text>
      )}
      <Text color={theme.muted} wrap="truncate-end">
        {confirm === undefined
          ? '↑↓ file · PgUp/PgDn scroll · u undo file · r refresh · Esc close'
          : 'Enter to choose · Esc to cancel'}
      </Text>
    </Box>
  );
}
