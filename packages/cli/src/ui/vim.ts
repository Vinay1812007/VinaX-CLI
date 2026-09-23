import type { Key } from 'ink';
import * as ed from './editor.js';

export type VimMode = 'insert' | 'normal';

export interface VimResult {
  editor: ed.EditorState;
  mode: VimMode;
  /** An operator waiting for its motion (`d`, `c`). */
  pending: string;
  /** Snapshot to push on the undo stack before this change. */
  changed: boolean;
  undo?: boolean;
  submit?: boolean;
  history?: 'up' | 'down';
}

/**
 * NORMAL-mode key handling for the prompt: motions (h j k l w b e 0 ^ $), edits (x X D C dd cc
 * dw cw), entering INSERT (i a I A o O) and undo (u). Returns `undefined` for keys it ignores.
 */
export function vimNormalKey(
  e: ed.EditorState,
  pending: string,
  input: string,
  key: Key,
): VimResult | undefined {
  const stay = (editor: ed.EditorState, changed = false): VimResult => ({
    editor,
    mode: 'normal',
    pending: '',
    changed,
  });
  const insert = (editor: ed.EditorState, changed = false): VimResult => ({
    editor,
    mode: 'insert',
    pending: '',
    changed,
  });
  if (key.return) return { editor: e, mode: 'normal', pending: '', changed: false, submit: true };
  if (pending === 'd' || pending === 'c') {
    const toInsert = pending === 'c';
    if (input === pending) {
      const cleared = toInsert ? ed.killToLineEnd(ed.lineStart(e)) : ed.deleteLine(e);
      return toInsert ? insert(cleared, true) : stay(cleared, true);
    }
    if (input === 'w' || input === 'e') {
      const next = ed.deleteWordForward(e);
      return toInsert ? insert(next, true) : stay(next, true);
    }
    if (input === '$') {
      const next = ed.killToLineEnd(e);
      return toInsert ? insert(next, true) : stay(next, true);
    }
    return stay(e);
  }
  if (key.leftArrow || input === 'h') return stay(ed.left(e));
  if (key.rightArrow || input === 'l') return stay(ed.right(e));
  if (key.upArrow || input === 'k') {
    const moved = ed.up(e);
    return moved
      ? stay(moved)
      : { editor: e, mode: 'normal', pending: '', changed: false, history: 'up' };
  }
  if (key.downArrow || input === 'j') {
    const moved = ed.down(e);
    return moved
      ? stay(moved)
      : { editor: e, mode: 'normal', pending: '', changed: false, history: 'down' };
  }
  switch (input) {
    case 'w':
      return stay(ed.wordRight(e));
    case 'b':
      return stay(ed.wordLeft(e));
    case 'e':
      return stay(ed.wordEnd(e));
    case '0':
      return stay(ed.lineStart(e));
    case '^':
      return stay(ed.firstNonBlank(e));
    case '$':
      return stay(ed.lineEnd(e));
    case 'x':
      return stay(ed.deleteForward(e), true);
    case 'X':
      return stay(ed.backspace(e), true);
    case 'D':
      return stay(ed.killToLineEnd(e), true);
    case 'C':
      return insert(ed.killToLineEnd(e), true);
    case 'S':
      return insert(ed.killToLineEnd(ed.lineStart(e)), true);
    case 'd':
    case 'c':
      return { editor: e, mode: 'normal', pending: input, changed: false };
    case 'i':
      return insert(e);
    case 'a':
      return insert(ed.right(e));
    case 'I':
      return insert(ed.firstNonBlank(e));
    case 'A':
      return insert(ed.lineEnd(e));
    case 'o':
      return insert(ed.insert(ed.lineEnd(e), '\n'), true);
    case 'O': {
      const atStart = ed.lineStart(e);
      return insert(ed.left(ed.insert(atStart, '\n')), true);
    }
    case 'u':
      return { editor: e, mode: 'normal', pending: '', changed: false, undo: true };
    default:
      return undefined;
  }
}
