import type { Key } from 'ink';
import { useEffect, useMemo, useRef, useState } from 'react';
import { searchHistory, type PromptHistory } from '@vinax/core';
import * as ed from './editor.js';
import { cleanTyped, isPrintable } from './keys.js';
import { PasteStore } from './paste.js';
import { useRefState } from './use-ref-state.js';

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

/**
 * The prompt box's editing behaviour: multi-line editing, history (↑/↓), reverse search
 * (Ctrl+R) and paste collapsing. Key handlers read refs so fast typing never uses stale state.
 */
export function usePromptEditor(opts: {
  history: PromptHistory;
  onSubmit: (s: Submission) => void;
  onShortcuts: () => void;
}) {
  const [editor, setEditor, editorRef] = useRefState<ed.EditorState>(ed.EMPTY);
  const [search, setSearch, searchRef] = useRefState<Search | undefined>(undefined);
  const [entries, setEntries] = useState<readonly string[]>([]);
  const pastes = useMemo(() => new PasteStore(), []);
  const historyIndex = useRef(-1);
  const draft = useRef<ed.EditorState>(ed.EMPTY);

  useEffect(() => {
    void opts.history.load().then(setEntries);
  }, [opts.history]);

  const clear = (): void => {
    setEditor(ed.EMPTY);
    setSearch(undefined);
    pastes.clear();
    historyIndex.current = -1;
  };

  const submit = (): void => {
    const raw = editorRef.current.value;
    if (raw.trim() === '') return;
    const prompt = pastes.expand(raw);
    clear();
    void opts.history.add(prompt).then(async () => {
      setEntries(await opts.history.load());
    });
    opts.onSubmit({ prompt, display: raw });
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
      else if (historyIndex.current + 1 < entries.length) {
        if (historyIndex.current === -1) draft.current = e;
        historyIndex.current++;
        setEditor(ed.fromText(entries[historyIndex.current] ?? ''));
      }
    } else if (key.downArrow) {
      const moved = ed.down(e);
      if (moved) setEditor(moved);
      else if (historyIndex.current > -1) {
        historyIndex.current--;
        setEditor(
          historyIndex.current === -1
            ? draft.current
            : ed.fromText(entries[historyIndex.current] ?? ''),
        );
      }
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

  return {
    editor,
    editorRef,
    searchView:
      search === undefined
        ? undefined
        : { query: search.query, match: searchHistory(entries, search.query)[search.index] },
    isSearching: () => searchRef.current !== undefined,
    clear,
    setText: (text: string) => {
      setEditor(ed.fromText(text));
    },
    handleKey: (input: string, key: Key): void => {
      const s = searchRef.current;
      if (s) handleSearchKey(input, key, s);
      else handleEditorKey(input, key);
    },
    handlePaste: (text: string): void => {
      const s = searchRef.current;
      if (s) setSearch({ query: s.query + text.replace(/\s+/g, ' '), index: 0 });
      else setEditor((e) => ed.insert(e, pastes.add(text)));
    },
  };
}
