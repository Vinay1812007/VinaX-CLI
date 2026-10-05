import {
  diffDisplay,
  displayPath,
  type CheckpointStore,
  type FileState,
  type RestoreStatus,
  type ToolDisplay,
} from '@vinax/core';

/** One file VinaX changed this session, compared with how it was before VinaX first touched it. */
export interface ChangeRow {
  file: string;
  /** Path relative to the project. */
  shown: string;
  /** Undoing the file restores it to before this turn. */
  firstTurn: number;
  /** `created`/`deleted`/`modified` relative to the original; `unchanged` once back to it. */
  kind: 'created' | 'deleted' | 'modified' | 'unchanged' | 'unreadable';
  /** Whether the file is exactly as VinaX left it (see RestoreStatus). */
  status: RestoreStatus;
  reason: string | undefined;
  added: number;
  removed: number;
  original: FileState;
  current: FileState | undefined;
}

export function changeKind(original: FileState, current: FileState | undefined): ChangeRow['kind'] {
  if (current === undefined) return 'unreadable';
  if (original === current) return 'unchanged';
  if (original === null) return 'created';
  if (current === null) return 'deleted';
  return 'modified';
}

/** The diff from the original to the current content (empty for unreadable files). */
export function changeDiff(
  row: Pick<ChangeRow, 'file' | 'original' | 'current'>,
): Extract<ToolDisplay, { kind: 'diff' }> {
  const d = diffDisplay(
    row.file,
    row.original ?? '',
    typeof row.current === 'string' ? row.current : '',
    row.original === null,
  );
  if (d.kind !== 'diff') throw new Error('diffDisplay returned a non-diff display');
  return d;
}

/** Every file VinaX can still undo this session, with its state on disk now. */
export async function loadChanges(checkpoints: CheckpointStore, cwd: string): Promise<ChangeRow[]> {
  const rows: ChangeRow[] = [];
  for (const c of checkpoints.sessionChanges()) {
    const plan = await checkpoints.planRestore(c.firstTurn, [c.file]);
    const p = plan.files[0];
    const current = p?.current;
    const row = {
      file: c.file,
      shown: displayPath(c.file, cwd),
      firstTurn: c.firstTurn,
      kind: changeKind(c.original, current),
      status: p?.status ?? 'clean',
      reason: p?.reason,
      added: 0,
      removed: 0,
      original: c.original,
      current,
    } satisfies ChangeRow;
    if (row.kind !== 'unreadable' && row.kind !== 'unchanged') {
      const d = changeDiff(row);
      row.added = d.added;
      row.removed = d.removed;
    }
    rows.push(row);
  }
  return rows;
}
