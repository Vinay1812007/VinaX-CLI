import {
  displayPath,
  type Agent,
  type CheckpointStore,
  type ConflictResolution,
  type RestoreResult,
} from '@vinax/core';
import type { ChangeRow } from './changes.js';
import type { RewindChoice } from './components/RewindPicker.js';
import { truncate } from './format.js';

export interface ReviewDeps {
  agent: Agent;
  checkpoints: CheckpointStore;
  cwd: string;
  notify: (level: 'info' | 'warning' | 'error', text: string) => void;
  /** Puts the rewound prompt back into the prompt box. */
  setPrompt: (text: string) => void;
}

const files = (n: number): string => `${String(n)} file${n === 1 ? '' : 's'}`;

/** The user-facing outcome of a restore that did not happen, or undefined when it did. */
function notRestored(r: RestoreResult, cwd: string, what: string): string | undefined {
  if (r.status === 'conflicts')
    return `Nothing was ${what}: ${r.conflicts.map((c) => displayPath(c.file, cwd)).join(', ')} changed while you were choosing. Open it again to review.`;
  if (r.status === 'failed')
    return `${what === 'rewound' ? 'Rewind' : 'Undo'} failed. ${r.error ?? ''}`;
  return undefined;
}

/**
 * Applies a rewind choice. Files are restored first; if that does not happen (a file changed in
 * the meantime, or a write failed) the conversation is left as it is, so the two never disagree.
 */
export async function performRewind(deps: ReviewDeps, choice: RewindChoice): Promise<void> {
  const { agent, checkpoints, cwd, notify } = deps;
  const target = agent.turns.find((t) => t.turn === choice.turn);
  const before = `before “${truncate(target?.prompt ?? '', 60)}”`;
  const shellRan = agent.shellCommandsSince(choice.turn);
  let restored: RestoreResult | undefined;
  if (choice.code) {
    restored = await checkpoints.restoreTo(choice.turn, { resolution: choice.resolution });
    const problem = notRestored(restored, cwd, 'rewound');
    if (problem !== undefined) {
      notify(
        restored.status === 'failed' ? 'error' : 'warning',
        `${problem} The conversation was not rewound.`,
      );
      return;
    }
  }
  if (choice.conversation) {
    const text = agent.rewindConversation(choice.turn);
    if (text !== undefined) deps.setPrompt(text);
  }
  const parts = [
    choice.conversation ? 'the conversation' : undefined,
    choice.code ? files(restored?.restored.length ?? 0) : undefined,
  ].filter((p): p is string => p !== undefined);
  const kept = restored?.kept ?? [];
  notify(
    'info',
    [
      `Rewound ${parts.join(' and ')} to ${before}. Earlier output above stays on screen.`,
      kept.length === 0
        ? ''
        : ` Kept your versions of ${kept.map((f) => displayPath(f, cwd)).join(', ')}.`,
      restored?.backup === undefined ? '' : ` Previous versions saved in ${restored.backup}.`,
      choice.code && shellRan > 0
        ? ` ${String(shellRan)} shell command${shellRan === 1 ? '' : 's'} ran since then; their effects were not undone.`
        : '',
    ].join(''),
  );
}

/**
 * Undoes VinaX's changes to one file (back to before the first turn that changed it). The model
 * is told, so it does not assume its edit is still there.
 */
export async function undoFile(
  deps: ReviewDeps,
  row: ChangeRow,
  resolution: ConflictResolution,
): Promise<string> {
  const { agent, checkpoints, cwd, notify } = deps;
  const r = await checkpoints.restoreTo(row.firstTurn, { only: [row.file], resolution });
  const problem = notRestored(r, cwd, 'undone');
  if (problem !== undefined) {
    notify(r.status === 'failed' ? 'error' : 'warning', problem);
    return problem;
  }
  const shown = displayPath(row.file, cwd);
  const how =
    row.original === null ? 'deleted it (it did not exist before)' : 'restored its earlier content';
  agent.addContext(
    `I undid your changes to ${shown} myself: VinaX ${how}, as it was before turn ${String(row.firstTurn)}. Read it again before relying on its content.`,
  );
  const text = `Undid VinaX's changes to ${shown}: ${how}.${r.backup === undefined ? '' : ` Previous version saved in ${r.backup}.`}`;
  notify('info', text);
  return text;
}
