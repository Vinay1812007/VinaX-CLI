import { Box, Static, Text, useInput, usePaste, useWindowSize } from 'ink';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  effectiveContextWindow,
  estimateTokens,
  formatModelRef,
  parseModelRef,
  projectDataDir,
  PromptHistory,
  providerLabel,
  updateSettingsFile,
  type AgentEvent,
  type AgentHost,
  type AgentSetup,
  type PermissionAnswer,
  type PermissionMode,
  type PermissionRequest,
  type PlanDecision,
  type Runtime,
  type TodoItem,
} from '@vinax/core';
import { truncate } from '../format.js';
import { useTheme } from '../theme.js';
import {
  splitStable,
  type ToolRecord,
  type TranscriptItem,
  type TurnRecord,
} from '../transcript.js';
import { usePromptEditor, type Submission } from '../use-prompt-editor.js';
import { useRefState } from '../use-ref-state.js';
import { ActivityIndicator } from './ActivityIndicator.js';
import { AssistantMarkdown, Notice, UserMessage } from './Messages.js';
import { PermissionPrompt } from './PermissionPrompt.js';
import { PlanPrompt } from './PlanPrompt.js';
import { PromptBox } from './PromptBox.js';
import { RewindPicker, type RewindChoice } from './RewindPicker.js';
import { ShortcutsHelp } from './ShortcutsHelp.js';
import { StatusLine, type StatusNotice } from './StatusLine.js';
import { TodoList } from './TodoList.js';
import { RunningTool, ToolEntry } from './ToolEntry.js';
import { TurnDetails } from './TurnDetails.js';
import { Welcome } from './Welcome.js';

const MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan'];
const EXIT_WINDOW_MS = 2000;
const DOUBLE_ESC_MS = 600;
const RUNNING_OUTPUT_CHARS = 4000;

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

interface Running {
  id: string;
  name: string;
  label: string;
  output: string;
}

type Pending =
  | { kind: 'permission'; req: PermissionRequest; resolve: (a: PermissionAnswer) => void }
  | { kind: 'plan'; plan: string; resolve: (d: PlanDecision) => void };

export interface ChatScreenProps {
  runtime: Runtime;
  setup: AgentSetup;
  version: string;
  tips: readonly string[];
  initialPrompt?: string | undefined;
  onExit: (code: number) => void;
  now?: () => number;
}

function initialItems(runtime: Runtime, setup: AgentSetup): TranscriptItem[] {
  const items: TranscriptItem[] = [{ id: 0, kind: 'welcome' }];
  const warn = (text: string, level: 'warning' | 'error' = 'warning') => {
    items.push({ id: items.length, kind: 'notice', level, text });
  };
  for (const w of runtime.warnings) warn(w);
  for (const r of setup.permissions.invalidRules) warn(`Ignoring malformed permission rule: ${r}`);
  if (runtime.providers.size === 0) {
    warn(
      'No API key is configured. Exit and run `vinax config set-key groq` (or set GROQ_API_KEY).',
      'error',
    );
  }
  return items;
}

export function ChatScreen({
  runtime,
  setup,
  version,
  tips,
  initialPrompt,
  onExit,
  now = Date.now,
}: ChatScreenProps) {
  const theme = useTheme();
  const { columns, rows } = useWindowSize();
  const width = Math.max(20, columns);
  const { agent, checkpoints } = setup;

  const [items, setItems] = useState<TranscriptItem[]>(() => initialItems(runtime, setup));
  const nextId = useRef(items.length);
  const push = (item: NewItem): void => {
    const id = nextId.current++;
    setItems((prev) => [...prev, { ...item, id }]);
  };

  const [streaming, setStreaming] = useState<Streaming | undefined>(undefined);
  const [running, setRunning] = useState<Running[]>([]);
  const [pending, setPending, pendingRef] = useRefState<Pending | undefined>(undefined);
  const [queued, setQueued, queuedRef] = useRefState<Submission[]>([]);
  const [overlay, setOverlay] = useState<'shortcuts' | 'details' | 'rewind' | undefined>(undefined);
  const [detailsOffset, setDetailsOffset] = useState(0);
  const [mode, setMode, modeRef] = useRefState<PermissionMode>(
    runtime.settings.resolved.permissions.defaultMode,
  );
  const [notice, setNotice] = useState<StatusNotice | undefined>(undefined);
  const [hint, setHint] = useState<string | undefined>(undefined);
  const [turns, setTurns] = useState<TurnRecord[]>([]);
  const [activeModel, setActiveModel] = useState(runtime.settings.resolved.model);
  const [contextPct, setContextPct] = useState<number | undefined>(undefined);
  const [todos, setTodos] = useState<TodoItem[]>([]);

  const abortRef = useRef<AbortController | undefined>(undefined);
  const tailRef = useRef('');
  const committedRef = useRef(false);
  const exitArmedAt = useRef<number | undefined>(undefined);
  const lastEscAt = useRef(0);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const history = useMemo(
    () => PromptHistory.forProject(projectDataDir(runtime.cwd, runtime.env)),
    [runtime],
  );

  useEffect(() => setup.todos.subscribe(setTodos), [setup]);

  const host = useMemo<AgentHost>(
    () => ({
      mode: () => modeRef.current,
      askPermission: (req, signal) =>
        new Promise<PermissionAnswer>((resolve) => {
          const onAbort = (): void => {
            setPending(undefined);
            resolve({ kind: 'deny', feedback: '' });
          };
          signal.addEventListener('abort', onAbort, { once: true });
          setPending({
            kind: 'permission',
            req,
            resolve: (answer) => {
              signal.removeEventListener('abort', onAbort);
              setPending(undefined);
              resolve(answer);
            },
          });
        }),
      approvePlan: (plan) =>
        new Promise<PlanDecision>((resolve) => {
          setPending({
            kind: 'plan',
            plan,
            resolve: (decision) => {
              setPending(undefined);
              if (decision.approved) setMode(decision.mode);
              resolve(decision);
            },
          });
        }),
      saveProjectRule: async (rule) => {
        const file = await updateSettingsFile(
          { cwd: runtime.cwd, env: runtime.env, scope: 'local' },
          (s) => {
            const perms = (s.permissions ?? {}) as { allow?: string[] };
            return {
              ...s,
              permissions: { ...perms, allow: [...new Set([...(perms.allow ?? []), rule])] },
            };
          },
        );
        push({ kind: 'notice', level: 'info', text: `Saved ${rule} to ${file}` });
      },
    }),
    // modeRef/setPending/setMode are stable
    [runtime],
  );

  const refreshContext = async (ref: string): Promise<void> => {
    try {
      const window = await effectiveContextWindow(parseModelRef(ref), runtime);
      setContextPct(Math.min(100, Math.round((estimateTokens(agent.messages) / window) * 100)));
    } catch {
      setContextPct(undefined);
    }
  };

  /** Moves the streamed text not yet printed into the permanent transcript. */
  const commitTail = (): void => {
    const rest = tailRef.current.trim();
    if (rest !== '') {
      push({ kind: 'assistant', markdown: rest, first: !committedRef.current });
      committedRef.current = true;
    }
    tailRef.current = '';
    setStreaming((s) => s && { ...s, tail: '' });
  };

  const runTurn = async (q: Submission): Promise<void> => {
    push({ kind: 'user', text: q.display });
    const ac = new AbortController();
    abortRef.current = ac;
    tailRef.current = '';
    committedRef.current = false;
    const startedAt = now();
    const fallbacks: string[] = [];
    const tools: ToolRecord[] = [];
    const labels = new Map<string, string>();
    let model: string | undefined;
    setNotice(undefined);
    setStreaming({ startedAt, tail: '', chars: 0, committed: false, waiting: undefined });

    const onEvent = (ev: AgentEvent): void => {
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
        case 'tool_call':
          commitTail();
          committedRef.current = false; // text after the tools is a new message
          labels.set(ev.id, ev.label);
          setRunning((r) => [...r, { id: ev.id, name: ev.name, label: ev.label, output: '' }]);
          return;
        case 'tool_progress':
          setRunning((r) =>
            r.map((t) =>
              t.id === ev.id
                ? { ...t, output: (t.output + ev.chunk).slice(-RUNNING_OUTPUT_CHARS) }
                : t,
            ),
          );
          return;
        case 'tool_result': {
          const label = labels.get(ev.id) ?? '';
          setRunning((r) => r.filter((t) => t.id !== ev.id));
          push({
            kind: 'tool',
            name: ev.name,
            label,
            ok: ev.ok,
            summary: ev.summary,
            display: ev.display,
          });
          tools.push({ name: ev.name, label, ok: ev.ok, summary: ev.summary, output: ev.content });
          return;
        }
        case 'notice':
          push({ kind: 'notice', level: ev.level, text: ev.text });
          return;
        case 'attempt':
          model = formatModelRef(ev.ref);
          setActiveModel(model);
          return;
        case 'wait': {
          const waiting = `Waiting ${String(Math.ceil(ev.ms / 1000))}s: ${providerLabel(ev.ref.provider)} ${ev.reason}`;
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

    const outcome = await agent.run(q.prompt, { signal: ac.signal, host, onEvent });
    abortRef.current = undefined;
    commitTail();
    setRunning([]);
    if (outcome.status === 'done' && outcome.steps === 1 && outcome.text.trim() === '') {
      push({ kind: 'notice', level: 'info', text: 'The model returned an empty answer.' });
    }
    if (outcome.status === 'interrupted') {
      push({
        kind: 'notice',
        level: 'warning',
        text: 'Interrupted — what VinaX did so far is kept.',
      });
    } else if (outcome.status === 'declined') {
      push({
        kind: 'notice',
        level: 'info',
        text: 'Stopped: you declined the action. Tell VinaX what to do instead.',
      });
    } else if (outcome.status === 'failed' || outcome.status === 'max_turns') {
      push({
        kind: 'notice',
        level: outcome.status === 'failed' ? 'error' : 'warning',
        text: outcome.error ?? 'The request failed.',
      });
    }
    setStreaming(undefined);
    setTurns((t) => [
      ...t,
      {
        prompt: q.display,
        model,
        inputTokens: outcome.usage.promptTokens || undefined,
        outputTokens: outcome.usage.completionTokens || undefined,
        durationMs: now() - startedAt,
        fallbacks,
        tools,
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

  const prompt = usePromptEditor({
    history,
    onSubmit: (s) => {
      if (abortRef.current) setQueued((list) => [...list, s]);
      else void runTurnRef.current(s);
    },
    onShortcuts: () => {
      setOverlay('shortcuts');
    },
  });

  useEffect(() => {
    void refreshContext(activeModel);
    if (initialPrompt !== undefined && initialPrompt.trim() !== '') {
      void runTurnRef.current({ prompt: initialPrompt, display: initialPrompt });
    }
    return () => {
      abortRef.current?.abort();
      setup.shell.killAll();
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

  const rewind = async (choice: RewindChoice | undefined): Promise<void> => {
    setOverlay(undefined);
    if (!choice) return;
    const target = agent.turns.find((t) => t.turn === choice.turn);
    const restored = choice.code ? await checkpoints.restoreTo(choice.turn) : [];
    if (choice.conversation) {
      const text = agent.rewindConversation(choice.turn);
      if (text !== undefined) prompt.setText(text);
    }
    const parts = [
      choice.conversation ? 'the conversation' : undefined,
      choice.code
        ? `${String(restored.length)} file${restored.length === 1 ? '' : 's'}`
        : undefined,
    ].filter((p): p is string => p !== undefined);
    push({
      kind: 'notice',
      level: 'info',
      text: `Rewound ${parts.join(' and ')} to before “${truncate(target?.prompt ?? '', 60)}”. Earlier output above stays on screen.`,
    });
    await refreshContext(activeModel);
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
      } else prompt.clear();
      exitArmedAt.current = now();
      flashHint('Press Ctrl+C again to exit');
      return;
    }
    // prompts and the rewind picker handle their own keys
    if (pendingRef.current !== undefined || overlay === 'rewind') return;
    if (key.ctrl && input === 'd') {
      if (prompt.editorRef.current.value === '') {
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
      const double = now() - lastEscAt.current < DOUBLE_ESC_MS;
      lastEscAt.current = now();
      if (abortRef.current) {
        setQueued([]);
        abortRef.current.abort();
      } else if (prompt.isSearching()) {
        prompt.handleKey(input, key);
      } else if (double && prompt.editorRef.current.value !== '') {
        prompt.clear();
      } else if (double && agent.turns.length > 0) {
        setOverlay('rewind');
      }
      return;
    }
    if (key.tab && key.shift) {
      setMode((m) => MODES[(MODES.indexOf(m) + 1) % MODES.length] ?? 'default');
      return;
    }
    prompt.handleKey(input, key);
  });

  usePaste((text) => {
    if (overlay === 'details' || pendingRef.current !== undefined) return;
    prompt.handlePaste(text);
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
      case 'tool':
        return (
          <ToolEntry
            key={item.id}
            name={item.name}
            label={item.label}
            ok={item.ok}
            summary={item.summary}
            display={item.display}
            width={width}
          />
        );
    }
  };

  const openTodos = todos.some((t) => t.status !== 'completed');
  const busy = streaming !== undefined;
  return (
    <Box flexDirection="column">
      <Static items={items}>{renderItem}</Static>
      {streaming !== undefined && streaming.tail.trim() !== '' ? (
        <AssistantMarkdown markdown={streaming.tail} first={!streaming.committed} width={width} />
      ) : null}
      {running.map((r) => (
        <RunningTool key={r.id} name={r.name} label={r.label} output={r.output} width={width} />
      ))}
      {pending?.kind === 'permission' ? (
        <PermissionPrompt
          req={pending.req}
          width={width}
          onAnswer={pending.resolve}
          onAcceptEdits={() => {
            setMode('acceptEdits');
          }}
        />
      ) : null}
      {pending?.kind === 'plan' ? (
        <PlanPrompt plan={pending.plan} width={width} onDecide={pending.resolve} />
      ) : null}
      {busy && pending === undefined ? (
        <Box marginTop={1}>
          <ActivityIndicator
            startedAt={streaming.startedAt}
            outputChars={streaming.chars}
            waiting={streaming.waiting}
            activity={running[0] === undefined ? undefined : `Running ${running[0].name}`}
            now={now}
          />
        </Box>
      ) : null}
      {queued.map((q, i) => (
        <Text key={`${String(i)}:${q.display}`} color={theme.muted}>
          queued › {truncate(q.display, width - 12)}
        </Text>
      ))}
      {openTodos ? (
        <Box flexDirection="column" marginTop={1} paddingLeft={2}>
          <Text color={theme.muted}>Tasks</Text>
          <TodoList todos={todos} />
        </Box>
      ) : null}
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
      {overlay === 'rewind' ? (
        <RewindPicker
          targets={agent.turns.map((t) => ({
            turn: t.turn,
            prompt: t.prompt,
            changedFiles: checkpoints.changedSince(t.turn).length,
          }))}
          width={width}
          onDone={(c) => void rewind(c)}
        />
      ) : null}
      {pending === undefined && overlay !== 'rewind' ? (
        <Box marginTop={1} flexDirection="column">
          <PromptBox
            editor={prompt.editor}
            placeholder={
              busy
                ? 'Type to queue a follow-up · esc to interrupt'
                : 'Ask VinaX anything · ? for shortcuts'
            }
            search={prompt.searchView}
            dimmed={busy}
          />
        </Box>
      ) : null}
      <StatusLine
        mode={mode}
        model={activeModel}
        contextPct={contextPct}
        notice={notice}
        hint={
          hint ?? (pending === undefined ? undefined : 'Waiting for your answer · Ctrl+C to stop')
        }
        width={width}
      />
    </Box>
  );
}
