import type { Key } from 'ink';
import { useEffect, useMemo, useRef, useState } from 'react';
import { searchHistory, type EditorMode, type PromptHistory } from '@vinax/core';
import * as ed from './editor.js';
import { cleanTyped, isPrintable } from './keys.js';
import { PasteStore } from './paste.js';
import { useRefState } from './use-ref-state.js';
import { vimNormalKey, type VimMode } from './vim.js';

export interface Submission {
  /** Full text sent to the model (pastes expanded). */
  prompt: string;
  /** What the transcript shows (pastes as placeholders). */
  display: string;
}

interface Search {
  query: string;
  index: number;
}

const UNDO_LIMIT = 50;

/**
 * The prompt box's editing behaviour: multi-line editing, history (↑/↓), reverse search
 * (Ctrl+R), paste collapsing and optional vim bindings. Key handlers read refs so fast typing
 * never works on stale state.
 */
export function usePromptEditor(opts: {
  history: PromptHistory;
  editorMode: () => EditorMode;
  onSubmit: (s: Submission) => void;
  onShortcuts: () => void;
}) {
  const [editor, setEditor, editorRef] = useRefState<ed.EditorState>(ed.EMPTY);
  const [search, setSearch, searchRef] = useRefState<Search | undefined>(undefined);
  const [vimMode, setVimMode, vimRef] = useRefState<VimMode>('insert');
  const [entries, setEntries] = useState<readonly string[]>([]);
  const pastes = useMemo(() => new PasteStore(), []);
  const historyIndex = useRef(-1);
  const draft = useRef<ed.EditorState>(ed.EMPTY);
  const pending = useRef('');
  const undo = useRef<ed.EditorState[]>([]);

  useEffect(() => {
    void opts.history.load().then(setEntries);
  }, [opts.history]);

  const snapshot = (): void => {
    undo.current.push(editorRef.current);
    if (undo.current.length > UNDO_LIMIT) undo.current.shift();
  };

  const clear = (): void => {
    setEditor(ed.EMPTY);
    setSearch(undefined);
    pastes.clear();
    historyIndex.current = -1;
    undo.current = [];
  };

  const submit = (): void => {
    const raw = editorRef.current.value;
    if (raw.trim() === '') return;
    const prompt = pastes.expand(raw);
    clear();
    if (opts.editorMode() === 'vim') setVimMode('insert');
    void opts.history.add(prompt).then(async () => {
      setEntries(await opts.history.load());
    });
    opts.onSubmit({ prompt, display: raw });
  };

  const historyStep = (dir: 'up' | 'down'): void => {
    if (dir === 'up' && historyIndex.current + 1 < entries.length) {
      if (historyIndex.current === -1) draft.current = editorRef.current;
      historyIndex.current++;
      setEditor(ed.fromText(entries[historyIndex.current] ?? ''));
    } else if (dir === 'down' && historyIndex.current > -1) {
      historyIndex.current--;
      setEditor(
        historyIndex.current === -1
          ? draft.current
          : ed.fromText(entries[historyIndex.current] ?? ''),
      );
    }
  };

  const handleSearchKey = (input: string, key: Key, s: Search): void => {
    const found = searchHistory(entries, s.query);
    if (key.return) {
      const match = found[s.index];
      if (match !== undefined) setEditor(ed.fromText(match));
      setSearch(undefined);
    } else if (key.escape) {
      setSearch(undefined);
    } else if (key.ctrl && input === 'r') {
      setSearch({ ...s, index: Math.min(s.index + 1, Math.max(0, found.length - 1)) });
    } else if (key.backspace || key.delete) {
      setSearch({ query: s.query.slice(0, -1), index: 0 });
    } else if (!key.ctrl && !key.meta && isPrintable(input)) {
      setSearch({ query: s.query + input, index: 0 });
    }
  };

  const handleVimNormal = (input: string, key: Key): void => {
    const r = vimNormalKey(editorRef.current, pending.current, input, key);
    if (!r) return;
    pending.current = r.pending;
    if (r.submit) {
      submit();
      return;
    }
    if (r.undo) {
      const prev = undo.current.pop();
      if (prev) setEditor(prev);
      return;
    }
    if (r.history) {
      historyStep(r.history);
      return;
    }
    if (r.changed || r.mode === 'insert') snapshot();
    setEditor(r.editor);
    setVimMode(r.mode);
  };

  const handleEditorKey = (input: string, key: Key): void => {
    const e = editorRef.current;
    if (key.return) {
      if (key.shift || key.meta) setEditor(ed.insert(e, '\n'));
      else if (e.cursor > 0 && e.value[e.cursor - 1] === '\\')
        setEditor(ed.insert(ed.backspace(e), '\n'));
      else submit();
    } else if (key.upArrow) {
      const moved = ed.up(e);
      if (moved) setEditor(moved);
      else historyStep('up');
    } else if (key.downArrow) {
      const moved = ed.down(e);
      if (moved) setEditor(moved);
      else historyStep('down');
    } else if (key.leftArrow) setEditor(key.meta || key.ctrl ? ed.wordLeft(e) : ed.left(e));
    else if (key.rightArrow) setEditor(key.meta || key.ctrl ? ed.wordRight(e) : ed.right(e));
    else if (key.home) setEditor(ed.lineStart(e));
    else if (key.end) setEditor(ed.lineEnd(e));
    else if (key.backspace) setEditor(key.meta ? ed.deleteWordBack(e) : ed.backspace(e));
    else if (key.delete) setEditor(ed.deleteForward(e));
    else if (key.ctrl) {
      if (input === 'a') setEditor(ed.lineStart(e));
      else if (input === 'e') setEditor(ed.lineEnd(e));
      else if (input === 'w') setEditor(ed.deleteWordBack(e));
      else if (input === 'u') setEditor(ed.killToLineStart(e));
      else if (input === 'k') setEditor(ed.killToLineEnd(e));
      else if (input === 'r') setSearch({ query: '', index: 0 });
    } else if (key.meta) {
      if (input === 'b') setEditor(ed.wordLeft(e));
      else if (input === 'f') setEditor(ed.wordRight(e));
    } else if (input === '?' && e.value === '') {
      opts.onShortcuts();
    } else if (input !== '' && !key.tab && !key.escape) {
      const text = cleanTyped(input);
      if (text !== '') setEditor(ed.insert(e, text));
    }
  };

  const vimActive = (): boolean => opts.editorMode() === 'vim';

  return {
    editor,
    editorRef,
    /** INSERT/NORMAL when vim bindings are on. */
    vimMode: vimActive() ? vimMode : undefined,
    searchView:
      search === undefined
        ? undefined
        : { query: search.query, match: searchHistory(entries, search.query)[search.index] },
    isSearching: () => searchRef.current !== undefined,
    clear,
    setText: (text: string) => {
      setEditor(ed.fromText(text));
    },
    /** Replaces `[start, end)` (a completion) and puts the cursor after it. */
    replaceRange: (start: number, end: number, text: string) => {
      const v = editorRef.current.value;
      setEditor({ value: v.slice(0, start) + text + v.slice(end), cursor: start + text.length });
    },
    submit,
    /** Vim: Esc in INSERT switches to NORMAL. Returns true when it did. */
    escapeToNormal: (): boolean => {
      if (!vimActive() || vimRef.current !== 'insert') return false;
      setVimMode('normal');
      pending.current = '';
      setEditor((e) => (e.cursor > 0 && e.cursor >= e.value.length ? ed.left(e) : e));
      return true;
    },
    handleKey: (input: string, key: Key): void => {
      const s = searchRef.current;
      if (s) handleSearchKey(input, key, s);
      else if (vimActive() && vimRef.current === 'normal') handleVimNormal(input, key);
      else handleEditorKey(input, key);
    },
    handlePaste: (text: string): void => {
      const s = searchRef.current;
      if (s) setSearch({ query: s.query + text.replace(/\s+/g, ' '), index: 0 });
      else setEditor((e) => ed.insert(e, pastes.add(text)));
    },
  };
}
