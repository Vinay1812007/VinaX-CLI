/** Pure multi-line text editing. `cursor` is an index into `value` (0…value.length). */
export interface EditorState {
  value: string;
  cursor: number;
}

export const EMPTY: EditorState = { value: '', cursor: 0 };

export function fromText(value: string): EditorState {
  return { value, cursor: value.length };
}

export function insert(s: EditorState, text: string): EditorState {
  return {
    value: s.value.slice(0, s.cursor) + text + s.value.slice(s.cursor),
    cursor: s.cursor + text.length,
  };
}

export function backspace(s: EditorState): EditorState {
  if (s.cursor === 0) return s;
  return { value: s.value.slice(0, s.cursor - 1) + s.value.slice(s.cursor), cursor: s.cursor - 1 };
}

export function deleteForward(s: EditorState): EditorState {
  if (s.cursor >= s.value.length) return s;
  return { value: s.value.slice(0, s.cursor) + s.value.slice(s.cursor + 1), cursor: s.cursor };
}

export function left(s: EditorState): EditorState {
  return { ...s, cursor: Math.max(0, s.cursor - 1) };
}

export function right(s: EditorState): EditorState {
  return { ...s, cursor: Math.min(s.value.length, s.cursor + 1) };
}

function lineStartIndex(value: string, cursor: number): number {
  return value.lastIndexOf('\n', cursor - 1) + 1;
}

function lineEndIndex(value: string, cursor: number): number {
  const i = value.indexOf('\n', cursor);
  return i === -1 ? value.length : i;
}

export function lineStart(s: EditorState): EditorState {
  return { ...s, cursor: lineStartIndex(s.value, s.cursor) };
}

export function lineEnd(s: EditorState): EditorState {
  return { ...s, cursor: lineEndIndex(s.value, s.cursor) };
}

/** Moves to the same column on the previous line; `undefined` when already on the first line. */
export function up(s: EditorState): EditorState | undefined {
  const start = lineStartIndex(s.value, s.cursor);
  if (start === 0) return undefined;
  const col = s.cursor - start;
  const prevStart = lineStartIndex(s.value, start - 1);
  return { ...s, cursor: Math.min(prevStart + col, start - 1) };
}

/** Moves to the same column on the next line; `undefined` when already on the last line. */
export function down(s: EditorState): EditorState | undefined {
  const end = lineEndIndex(s.value, s.cursor);
  if (end === s.value.length) return undefined;
  const col = s.cursor - lineStartIndex(s.value, s.cursor);
  const nextStart = end + 1;
  return { ...s, cursor: Math.min(nextStart + col, lineEndIndex(s.value, nextStart)) };
}

export function wordLeft(s: EditorState): EditorState {
  let i = s.cursor;
  while (i > 0 && /\s/.test(s.value[i - 1] ?? '')) i--;
  while (i > 0 && !/\s/.test(s.value[i - 1] ?? '')) i--;
  return { ...s, cursor: i };
}

export function wordRight(s: EditorState): EditorState {
  let i = s.cursor;
  while (i < s.value.length && /\s/.test(s.value[i] ?? '')) i++;
  while (i < s.value.length && !/\s/.test(s.value[i] ?? '')) i++;
  return { ...s, cursor: i };
}

/** Ctrl+W: delete back to the previous whitespace. */
export function deleteWordBack(s: EditorState): EditorState {
  const to = wordLeft(s).cursor;
  return { value: s.value.slice(0, to) + s.value.slice(s.cursor), cursor: to };
}

/** Ctrl+K: delete to the end of the line. */
export function killToLineEnd(s: EditorState): EditorState {
  const end = lineEndIndex(s.value, s.cursor);
  const cut = end === s.cursor && end < s.value.length ? end + 1 : end;
  return { value: s.value.slice(0, s.cursor) + s.value.slice(cut), cursor: s.cursor };
}

/** Ctrl+U: delete to the start of the line. */
export function killToLineStart(s: EditorState): EditorState {
  const start = lineStartIndex(s.value, s.cursor);
  return { value: s.value.slice(0, start) + s.value.slice(s.cursor), cursor: start };
}

/** Vim `e`: to the last character of the current or next word. */
export function wordEnd(s: EditorState): EditorState {
  let i = Math.min(s.cursor + 1, s.value.length);
  while (i < s.value.length && /\s/.test(s.value[i] ?? '')) i++;
  while (i + 1 < s.value.length && !/\s/.test(s.value[i + 1] ?? '')) i++;
  return { ...s, cursor: Math.min(i, Math.max(0, s.value.length - 1)) };
}

/** Vim `dw`: delete from the cursor to the start of the next word. */
export function deleteWordForward(s: EditorState): EditorState {
  const to = wordRight(s).cursor;
  let end = to;
  while (end < s.value.length && s.value[end] === ' ') end++;
  return { value: s.value.slice(0, s.cursor) + s.value.slice(end), cursor: s.cursor };
}

/** Vim `dd`: delete the current line. */
export function deleteLine(s: EditorState): EditorState {
  const start = lineStart(s).cursor;
  const end = lineEnd(s).cursor;
  const removeFrom = end < s.value.length ? start : Math.max(0, start - 1);
  const removeTo = end < s.value.length ? end + 1 : end;
  const value = s.value.slice(0, removeFrom) + s.value.slice(removeTo);
  return { value, cursor: Math.min(removeFrom, value.length) };
}

/** Vim `^`: first non-blank character of the line. */
export function firstNonBlank(s: EditorState): EditorState {
  let i = lineStart(s).cursor;
  while (i < s.value.length && (s.value[i] === ' ' || s.value[i] === '\t')) i++;
  return { ...s, cursor: i };
}
