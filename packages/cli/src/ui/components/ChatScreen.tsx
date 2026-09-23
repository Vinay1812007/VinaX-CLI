import { Box, Static, Text, useInput, usePaste, useWindowSize, type Key } from 'ink';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChatSession,
  chatSystemPrompt,
  currentEnvironment,
  effectiveContextWindow,
  formatModelRef,
  parseModelRef,
  projectDataDir,
  PromptHistory,
  providerLabel,
  searchHistory,
  type PermissionMode,
  type RouterEvent,
  type Runtime,
} from '@vinax/core';
import * as ed from '../editor.js';
import { truncate } from '../format.js';
import { cleanTyped, isPrintable } from '../keys.js';
import { PasteStore } from '../paste.js';
import { useTheme } from '../theme.js';
import { splitStable, type TranscriptItem, type TurnRecord } from '../transcript.js';
import { useRefState } from '../use-ref-state.js';
import { ActivityIndicator } from './ActivityIndicator.js';
import { AssistantMarkdown, Notice, UserMessage } from './Messages.js';
import { PromptBox } from './PromptBox.js';
import { ShortcutsHelp } from './ShortcutsHelp.js';
import { StatusLine, type StatusNotice } from './StatusLine.js';
import { TurnDetails } from './TurnDetails.js';
import { Welcome } from './Welcome.js';

const MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan'];
const EXIT_WINDOW_MS = 2000;
const DOUBLE_ESC_MS = 600;

type NewItem = TranscriptItem extends infer T
  ? T extends { id: number }
    ? Omit<T, 'id'>
    : never
  : never;

interface Streaming {
  startedAt: number;
  tail: string;
  chars: number;
  committed: boolean;
  waiting: string | undefined;
}

interface Search {
  query: string;
  index: number;
}

interface Queued {
  prompt: string;
  display: string;
}

export interface ChatScreenProps {
  runtime: Runtime;
  version: string;
  tips: readonly string[];
  initialPrompt?: string | undefined;
  modelOverride?: string | undefined;
  onExit: (code: number) => void;
  now?: () => number;
}

function initialItems(runtime: Runtime): TranscriptItem[] {
  const items: TranscriptItem[] = [{ id: 0, kind: 'welcome' }];
  for (const w of runtime.warnings)
    items.push({ id: items.length, kind: 'notice', level: 'warning', text: w });
  if (runtime.providers.size === 0) {
    items.push({
      id: items.length,
      kind: 'notice',
      level: 'error',
      text: 'No API key is configured. Exit and run `vinax config set-key groq` (or set GROQ_API_KEY).',
    });
  }
  return items;
}

export function ChatScreen({
  runtime,
  version,
  tips,
  initialPrompt,
  modelOverride,
  onExit,
  now = Date.now,
}: ChatScreenProps) {
  const theme = useTheme();
  const { columns, rows } = useWindowSize();
  const width = Math.max(20, columns);

  const session = useMemo(
    () => new ChatSession(runtime.router, chatSystemPrompt(currentEnvironment(runtime.cwd))),
    [runtime],
  );
  const history = useMemo(
    () => PromptHistory.forProject(projectDataDir(runtime.cwd, runtime.env)),
    [runtime],
  );
  const pastes = useMemo(() => new PasteStore(), []);

  const [items, setItems] = useState<TranscriptItem[]>(() => initialItems(runtime));
  const nextId = useRef(items.length);
  const push = (item: NewItem): void => {
    const id = nextId.current++;
    setItems((prev) => [...prev, { ...item, id }]);
  };

  const [editor, setEditor, editorRef] = useRefState<ed.EditorState>(ed.EMPTY);
  const [search, setSearch, searchRef] = useRefState<Search | undefined>(undefined);
  const [streaming, setStreaming] = useState<Streaming | undefined>(undefined);
  const [queued, setQueued, queuedRef] = useRefState<Queued[]>([]);
  const [overlay, setOverlay] = useState<'shortcuts' | 'details' | undefined>(undefined);
  const [detailsOffset, setDetailsOffset] = useState(0);
  const [mode, setMode] = useState<PermissionMode>(
    runtime.settings.resolved.permissions.defaultMode,
  );
  const [notice, setNotice] = useState<StatusNotice | undefined>(undefined);
  const [hint, setHint] = useState<string | undefined>(undefined);
  const [turns, setTurns] = useState<TurnRecord[]>([]);
  const [activeModel, setActiveModel] = useState(modelOverride ?? runtime.settings.resolved.model);
  const [contextPct, setContextPct] = useState<number | undefined>(undefined);
  const [entries, setEntries] = useState<readonly string[]>([]);

  const abortRef = useRef<AbortController | undefined>(undefined);
  const tailRef = useRef('');
  const committedRef = useRef(false);
  const historyIndex = useRef(-1);
  const draft = useRef<ed.EditorState>(ed.EMPTY);
  const exitArmedAt = useRef<number | undefined>(undefined);
  const lastEscAt = useRef(0);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Read through a function: TypeScript would otherwise narrow the ref across awaits.
  const hasCommitted = (): boolean => committedRef.current;

  const refreshContext = async (ref: string): Promise<void> => {
    try {
      const window = await effectiveContextWindow(parseModelRef(ref), runtime);
      setContextPct(Math.min(100, Math.round((session.contextTokens() / window) * 100)));
    } catch {
      setContextPct(undefined);
    }
  };

  const runTurn = async (q: Queued): Promise<void> => {
    push({ kind: 'user', text: q.display });
    const ac = new AbortController();
    abortRef.current = ac;
    tailRef.current = '';
    committedRef.current = false;
    const startedAt = now();
    const fallbacks: string[] = [];
    let model: string | undefined;
    setNotice(undefined);
    setStreaming({ startedAt, tail: '', chars: 0, committed: false, waiting: undefined });

    const onEvent = (ev: RouterEvent): void => {
      switch (ev.type) {
        case 'text': {
          tailRef.current += ev.text;
          const { stable, rest } = splitStable(tailRef.current);
          if (stable !== '') {
            push({ kind: 'assistant', markdown: stable, first: !committedRef.current });
            committedRef.current = true;
            tailRef.current = rest;
          }
          const tail = tailRef.current;
          const committed = committedRef.current;
          setStreaming(
            (s) =>
              s && { ...s, tail, committed, chars: s.chars + ev.text.length, waiting: undefined },
          );
          return;
        }
        case 'attempt':
          model = formatModelRef(ev.ref);
          setActiveModel(model);
          return;
        case 'wait': {
          const secs = Math.ceil(ev.ms / 1000);
          const waiting = `Waiting ${String(secs)}s: ${providerLabel(ev.ref.provider)} ${ev.reason}`;
          setStreaming((s) => s && { ...s, waiting });
          return;
        }
        case 'retry':
          setNotice({
            level: 'warning',
            text: `↻ ${ev.reason} — retrying in ${(ev.delayMs / 1000).toFixed(1)}s`,
          });
          return;
        case 'fallback': {
          const to = formatModelRef(ev.to);
          fallbacks.push(to);
          const text = `${ev.reason} — switched to ${to}`;
          push({ kind: 'notice', level: 'info', text });
          setNotice({ level: 'warning', text: `↪ ${text}` });
          return;
        }
        case 'done':
          return;
      }
    };

    const outcome = await session.send(q.prompt, {
      signal: ac.signal,
      onEvent,
      ...(modelOverride === undefined ? {} : { model: modelOverride }),
    });
    abortRef.current = undefined;

    const rest = tailRef.current.trim();
    const committed = hasCommitted();
    if (rest !== '') push({ kind: 'assistant', markdown: rest, first: !committed });
    else if (!committed && outcome.status === 'done') {
      push({ kind: 'notice', level: 'info', text: 'The model returned an empty answer.' });
    }
    if (outcome.status === 'interrupted') {
      push({
        kind: 'notice',
        level: 'warning',
        text: 'Interrupted — what VinaX wrote so far is kept.',
      });
    }
    if (outcome.status === 'failed') {
      push({ kind: 'notice', level: 'error', text: outcome.error ?? 'The request failed.' });
    }
    setStreaming(undefined);
    setTurns((t) => [
      ...t,
      {
        prompt: q.display,
        model,
        inputTokens: outcome.usage?.promptTokens,
        outputTokens: outcome.usage?.completionTokens,
        durationMs: now() - startedAt,
        fallbacks,
        status: outcome.status,
      },
    ]);
    await refreshContext(model ?? activeModel);

    // Esc and Ctrl+C clear the queue, so anything left here was typed during this turn.
    const [next, ...remaining] = queuedRef.current;
    setQueued(remaining);
    if (next !== undefined) void runTurnRef.current(next);
  };
  const runTurnRef = useRef(runTurn);
  runTurnRef.current = runTurn;

  useEffect(() => {
    void history.load().then(setEntries);
    void refreshContext(activeModel);
    if (initialPrompt !== undefined && initialPrompt.trim() !== '') {
      void runTurnRef.current({ prompt: initialPrompt, display: initialPrompt });
    }
    return () => {
      abortRef.current?.abort();
      if (hintTimer.current) clearTimeout(hintTimer.current);
    };
  }, []); // mount only

  const flashHint = (text: string): void => {
    setHint(text);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => {
      setHint(undefined);
    }, EXIT_WINDOW_MS);
  };

  const submit = (): void => {
    const raw = editorRef.current.value;
    if (raw.trim() === '') return;
    const prompt = pastes.expand(raw);
    pastes.clear();
    setEditor(ed.EMPTY);
    historyIndex.current = -1;
    void history.add(prompt).then(async () => {
      setEntries(await history.load());
    });
    const q = { prompt, display: raw };
    if (abortRef.current) setQueued((list) => [...list, q]);
    else void runTurn(q);
  };

  const matches = search === undefined ? [] : searchHistory(entries, search.query);

  const handleSearchKey = (input: string, key: Key, s: Search): void => {
    const found = searchHistory(entries, s.query);
    if (key.return) {
      const match = found[s.index];
      if (match !== undefined) setEditor(ed.fromText(match));
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
      return;
    }
    if (key.upArrow) {
      const moved = ed.up(e);
      if (moved) setEditor(moved);
      else if (historyIndex.current + 1 < entries.length) {
        if (historyIndex.current === -1) draft.current = e;
        historyIndex.current++;
        setEditor(ed.fromText(entries[historyIndex.current] ?? ''));
      }
      return;
    }
    if (key.downArrow) {
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
      return;
    }
    if (key.leftArrow) setEditor(key.meta || key.ctrl ? ed.wordLeft(e) : ed.left(e));
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
      setOverlay('shortcuts');
    } else if (input !== '' && !key.tab && !key.escape) {
      const text = cleanTyped(input);
      if (text !== '') setEditor(ed.insert(e, text));
    }
  };

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      const armed =
        exitArmedAt.current !== undefined && now() - exitArmedAt.current < EXIT_WINDOW_MS;
      if (armed) {
        abortRef.current?.abort();
        onExit(0);
        return;
      }
      if (abortRef.current) {
        setQueued([]);
        abortRef.current.abort();
      } else {
        setEditor(ed.EMPTY);
        setSearch(undefined);
        pastes.clear();
      }
      exitArmedAt.current = now();
      flashHint('Press Ctrl+C again to exit');
      return;
    }
    if (key.ctrl && input === 'd') {
      if (editorRef.current.value === '') {
        abortRef.current?.abort();
        onExit(0);
      }
      return;
    }
    if (overlay === 'details') {
      if (key.escape || (key.ctrl && input === 'o')) setOverlay(undefined);
      else if (key.upArrow) setDetailsOffset((o) => Math.min(o + 1, Math.max(0, turns.length - 1)));
      else if (key.downArrow) setDetailsOffset((o) => Math.max(0, o - 1));
      return;
    }
    if (overlay === 'shortcuts') {
      setOverlay(undefined);
      if (key.escape || input === '?') return;
    }
    if (key.ctrl && input === 'o') {
      setDetailsOffset(0);
      setOverlay('details');
      return;
    }
    if (key.escape) {
      if (abortRef.current) {
        setQueued([]);
        abortRef.current.abort();
      } else if (searchRef.current) {
        setSearch(undefined);
      } else if (now() - lastEscAt.current < DOUBLE_ESC_MS && editorRef.current.value !== '') {
        setEditor(ed.EMPTY);
        pastes.clear();
      }
      lastEscAt.current = now();
      return;
    }
    if (key.tab && key.shift) {
      setMode((m) => MODES[(MODES.indexOf(m) + 1) % MODES.length] ?? 'default');
      return;
    }
    const s = searchRef.current;
    if (s) handleSearchKey(input, key, s);
    else handleEditorKey(input, key);
  });

  usePaste((text) => {
    if (overlay === 'details') return;
    const s = searchRef.current;
    if (s) setSearch({ query: s.query + text.replace(/\s+/g, ' '), index: 0 });
    else setEditor((e) => ed.insert(e, pastes.add(text)));
  });

  const modelRef = parseModelRef(activeModel);
  const renderItem = (item: TranscriptItem) => {
    switch (item.kind) {
      case 'welcome':
        return (
          <Welcome
            key={item.id}
            version={version}
            cwd={runtime.cwd}
            model={modelRef.model}
            provider={providerLabel(modelRef.provider)}
            tips={tips}
            width={width}
          />
        );
      case 'user':
        return <UserMessage key={item.id} text={item.text} />;
      case 'assistant':
        return (
          <AssistantMarkdown
            key={item.id}
            markdown={item.markdown}
            first={item.first}
            width={width}
          />
        );
      case 'notice':
        return <Notice key={item.id} level={item.level} text={item.text} />;
    }
  };

  return (
    <Box flexDirection="column">
      <Static items={items}>{renderItem}</Static>
      {streaming !== undefined && streaming.tail.trim() !== '' ? (
        <AssistantMarkdown markdown={streaming.tail} first={!streaming.committed} width={width} />
      ) : null}
      {streaming === undefined ? null : (
        <Box marginTop={1}>
          <ActivityIndicator
            startedAt={streaming.startedAt}
            outputChars={streaming.chars}
            waiting={streaming.waiting}
            now={now}
          />
        </Box>
      )}
      {queued.map((q, i) => (
        <Text key={`${String(i)}:${q.display}`} color={theme.muted}>
          queued › {truncate(q.display, width - 12)}
        </Text>
      ))}
      {overlay === 'shortcuts' ? <ShortcutsHelp /> : null}
      {overlay === 'details' ? (
        <TurnDetails
          turns={turns}
          limits={runtime.ledger.entries()}
          offset={detailsOffset}
          height={rows}
          width={width}
        />
      ) : null}
      <Box marginTop={1} flexDirection="column">
        <PromptBox
          editor={editor}
          placeholder="Ask VinaX anything · ? for shortcuts"
          search={
            search === undefined ? undefined : { query: search.query, match: matches[search.index] }
          }
          dimmed={streaming !== undefined}
        />
        <StatusLine
          mode={mode}
          model={activeModel}
          contextPct={contextPct}
          notice={notice}
          hint={hint}
          width={width}
        />
      </Box>
    </Box>
  );
}
