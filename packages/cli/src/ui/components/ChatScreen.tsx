import { Box, Static, Text, useApp, useInput, usePaste, useWindowSize } from 'ink';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  attachMentions,
  FileIndex,
  formatModelRef,
  generateTitle,
  parseModelRef,
  projectDataDir,
  PromptHistory,
  providerLabel,
  updateSettingsFile,
  type AgentEvent,
  type AgentHost,
  type AgentSetup,
  type EditorMode,
  type PermissionAnswer,
  type PermissionMode,
  type PermissionRequest,
  type PlanDecision,
  type Runtime,
  type SessionWriter,
  type ThemeName,
  type TodoItem,
} from '@vinax/core';
import { findCommand } from '../commands/registry.js';
import { parseSlash, type CommandContext, type SlashCommand } from '../commands/types.js';
import { formatTokens, truncate } from '../format.js';
import { useTheme } from '../theme.js';
import {
  splitStable,
  type ToolRecord,
  type TranscriptItem,
  type TurnRecord,
} from '../transcript.js';
import { usePromptEditor, type Submission } from '../use-prompt-editor.js';
import { useRefState } from '../use-ref-state.js';
import { useSuggestions } from '../use-suggestions.js';
import { ActivityIndicator } from './ActivityIndicator.js';
import { AssistantMarkdown, Notice, Panel, ShellEntry, UserMessage } from './Messages.js';
import { AskOverlay, PickerOverlay } from './Overlays.js';
import { PermissionPrompt } from './PermissionPrompt.js';
import { PlanPrompt } from './PlanPrompt.js';
import { PromptBox } from './PromptBox.js';
import { RewindPicker, type RewindChoice } from './RewindPicker.js';
import type { SelectItem } from './Select.js';
import { ShortcutsHelp } from './ShortcutsHelp.js';
import { StatusLine, type StatusNotice } from './StatusLine.js';
import { Suggestions } from './Suggestions.js';
import { TodoList } from './TodoList.js';
import { RunningTool, ToolEntry } from './ToolEntry.js';
import { TurnDetails } from './TurnDetails.js';
import { Welcome } from './Welcome.js';

const MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan'];
const EXIT_WINDOW_MS = 2000;
const DOUBLE_ESC_MS = 600;
const RUNNING_OUTPUT_CHARS = 4000;
const SHELL_CONTEXT_CHARS = 6000;

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
  /** Replaces the rotating verb, e.g. "Compacting the conversation". */
  label?: string;
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

type Overlay =
  | { kind: 'shortcuts' }
  | { kind: 'details' }
  | { kind: 'rewind' }
  | {
      kind: 'picker';
      title: string;
      items: readonly SelectItem<unknown>[];
      resolve: (v: unknown) => void;
    }
  | {
      kind: 'ask';
      title: string;
      placeholder: string;
      mask: boolean;
      resolve: (v: string | undefined) => void;
    };

interface Queued extends Submission {
  allowRules?: readonly string[] | undefined;
  model?: string | undefined;
}

export interface ChatScreenProps {
  runtime: Runtime;
  setup: AgentSetup;
  session: SessionWriter;
  commands: readonly SlashCommand[];
  version: string;
  tips: readonly string[];
  /** Transcript of a resumed session. */
  restored?: readonly TranscriptItem[];
  title?: string | undefined;
  startupNotices?: readonly string[];
  initialPrompt?: string | undefined;
  editorMode: EditorMode;
  onExit: (code: number) => void;
  onClear: () => void;
  onResume: (id: string) => void;
  onTheme: (theme: ThemeName) => void;
  now?: () => number;
}

function initialItems(p: ChatScreenProps): TranscriptItem[] {
  const items: TranscriptItem[] = [{ id: 0, kind: 'welcome' }];
  const warn = (text: string, level: 'warning' | 'error' | 'info' = 'warning') => {
    items.push({ id: items.length, kind: 'notice', level, text });
  };
  for (const r of p.restored ?? []) items.push({ ...r, id: items.length });
  if ((p.restored ?? []).length > 0) warn(`Resumed “${p.title ?? 'untitled session'}”.`, 'info');
  for (const w of p.runtime.warnings) warn(w);
  for (const w of p.startupNotices ?? []) warn(w);
  for (const r of p.setup.permissions.invalidRules)
    warn(`Ignoring malformed permission rule: ${r}`);
  if (p.runtime.providers.size === 0) {
    warn('No API key is configured. Use /login to add one.', 'error');
  }
  return items;
}

export function ChatScreen(props: ChatScreenProps) {
  const {
    runtime,
    setup,
    session,
    commands,
    version,
    tips,
    initialPrompt,
    onExit,
    now = Date.now,
  } = props;
  const theme = useTheme();
  const { suspendTerminal } = useApp();
  const { columns, rows } = useWindowSize();
  const width = Math.max(20, columns);
  const { agent, checkpoints } = setup;

  const [items, setItems] = useState<TranscriptItem[]>(() => initialItems(props));
  const nextId = useRef(items.length);
  const push = (item: NewItem): void => {
    const id = nextId.current++;
    session.record({ type: 'view', data: item });
    setItems((prev) => [...prev, { ...item, id }]);
  };

  const [streaming, setStreaming] = useState<Streaming | undefined>(undefined);
  const [running, setRunning] = useState<Running[]>([]);
  const [pending, setPending, pendingRef] = useRefState<Pending | undefined>(undefined);
  const [queued, setQueued, queuedRef] = useRefState<Queued[]>([]);
  const [overlay, setOverlay, overlayRef] = useRefState<Overlay | undefined>(undefined);
  const [detailsOffset, setDetailsOffset] = useState(0);
  const [mode, setMode, modeRef] = useRefState<PermissionMode>(
    runtime.settings.resolved.permissions.defaultMode,
  );
  const [, setEditorMode, editorModeRef] = useRefState<EditorMode>(props.editorMode);
  const [notice, setNotice] = useState<StatusNotice | undefined>(undefined);
  const [hint, setHint] = useState<string | undefined>(undefined);
  const [turns, setTurns] = useState<TurnRecord[]>([]);
  const [activeModel, setActiveModel] = useState(agent.model ?? runtime.settings.resolved.model);
  const [contextPct, setContextPct] = useState<number | undefined>(undefined);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [, setTitle, titleRef] = useRefState<string | undefined>(props.title);

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
  const files = useMemo(() => new FileIndex(runtime.cwd), [runtime]);

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
    [runtime],
  );

  const refreshContext = (): void => {
    const limit = setup.contextLimit();
    setContextPct(
      Number.isFinite(limit)
        ? Math.min(100, Math.round((agent.requestTokens(modeRef.current) / limit) * 100))
        : undefined,
    );
  };

  const commitTail = (): void => {
    const rest = tailRef.current.trim();
    if (rest !== '') {
      push({ kind: 'assistant', markdown: rest, first: !committedRef.current });
      committedRef.current = true;
    }
    tailRef.current = '';
    setStreaming((s) => s && { ...s, tail: '' });
  };

  const flashHint = (text: string): void => {
    setHint(text);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => {
      setHint(undefined);
    }, EXIT_WINDOW_MS);
  };

  // read through a function: TypeScript would otherwise narrow the ref across awaits
  const isBusy = (): boolean => abortRef.current !== undefined;

  const drainQueue = (): void => {
    const [next, ...remaining] = queuedRef.current;
    setQueued(remaining);
    if (next !== undefined) void handleSubmitRef.current(next);
  };

  const runTurn = async (q: Queued): Promise<void> => {
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
          committedRef.current = false;
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
        case 'compact':
          push({
            kind: 'notice',
            level: 'info',
            text:
              ev.kind === 'summary'
                ? `Compacted the conversation to stay within the context budget (~${formatTokens(ev.before)} → ~${formatTokens(ev.after)} tokens).`
                : `Trimmed old tool output to save context (~${formatTokens(ev.before)} → ~${formatTokens(ev.after)} tokens).`,
          });
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

    const outcome = await agent.run(q.prompt, {
      signal: ac.signal,
      host,
      onEvent,
      ...(q.allowRules === undefined ? {} : { allowRules: q.allowRules }),
      ...(q.model === undefined ? {} : { model: q.model }),
    });
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
    refreshContext();
    if (titleRef.current === undefined && outcome.status === 'done') {
      void generateTitle(runtime.router, q.display, AbortSignal.timeout(20_000)).then((t) => {
        if (t === undefined || titleRef.current !== undefined) return;
        session.record({ type: 'title', title: t });
        setTitle(t);
      });
    }
    drainQueue();
  };

  /** `!command`: run it directly and give the output to the model as context. */
  const runShell = async (command: string): Promise<void> => {
    const ac = new AbortController();
    abortRef.current = ac;
    setStreaming({
      startedAt: now(),
      tail: '',
      chars: 0,
      committed: false,
      waiting: undefined,
      label: `Running ${truncate(command, 40)}`,
    });
    const r = await setup.shell.run(command, { timeoutMs: 600_000, signal: ac.signal });
    abortRef.current = undefined;
    setStreaming(undefined);
    push({ kind: 'shell', command, output: r.output, exitCode: r.exitCode });
    const out =
      r.output.length > SHELL_CONTEXT_CHARS
        ? `${r.output.slice(-SHELL_CONTEXT_CHARS)}\n[earlier output omitted]`
        : r.output;
    agent.addContext(
      `I ran a shell command myself:\n<shell-command>${command}</shell-command>\n<shell-output exit-code="${String(r.exitCode ?? '?')}">\n${out}\n</shell-output>`,
    );
    refreshContext();
    drainQueue();
  };

  const pick = <T,>(
    pickTitle: string,
    pickItems: readonly SelectItem<T>[],
  ): Promise<T | undefined> =>
    new Promise((resolve) => {
      setOverlay({
        kind: 'picker',
        title: pickTitle,
        items: pickItems,
        resolve: (v) => {
          setOverlay(undefined);
          resolve(v as T | undefined);
        },
      });
    });

  const ask = (
    askTitle: string,
    placeholder: string,
    opts: { mask?: boolean } = {},
  ): Promise<string | undefined> =>
    new Promise((resolve) => {
      setOverlay({
        kind: 'ask',
        title: askTitle,
        placeholder,
        mask: opts.mask === true,
        resolve: (v) => {
          setOverlay(undefined);
          resolve(v);
        },
      });
    });

  /** `#note`: save to a memory file. */
  const saveNote = async (note: string): Promise<void> => {
    if (note.trim() === '') return;
    const scope = await pick('Save this note to which memory?', [
      { label: 'Project memory (VINAX.md in this folder)', value: 'project' as const },
      { label: 'Your personal memory (~/.vinax/VINAX.md, all projects)', value: 'user' as const },
    ]);
    if (scope === undefined) return;
    const file = await setup.memory.addNote(scope, note);
    push({ kind: 'notice', level: 'info', text: `Noted in ${file}` });
  };

  const commandContext = (args: string): CommandContext => ({
    runtime,
    setup,
    session,
    args,
    panel: (panelTitle, markdown) => {
      push({ kind: 'panel', title: panelTitle, markdown });
    },
    notice: (level, text) => {
      push({ kind: 'notice', level, text });
    },
    send: (prompt, opts = {}) => {
      void handleSubmitRef.current({
        prompt,
        display: opts.display ?? prompt,
        raw: true,
        ...(opts.allowRules === undefined ? {} : { allowRules: opts.allowRules }),
        ...(opts.model === undefined ? {} : { model: opts.model }),
      });
    },
    pick,
    ask,
    busy: async (label, task) => {
      const ac = new AbortController();
      abortRef.current = ac;
      setStreaming({
        startedAt: now(),
        tail: '',
        chars: 0,
        committed: false,
        waiting: undefined,
        label,
      });
      try {
        return await task(ac.signal);
      } catch (err) {
        if (!ac.signal.aborted)
          push({
            kind: 'notice',
            level: 'error',
            text: err instanceof Error ? err.message : String(err),
          });
        return undefined;
      } finally {
        abortRef.current = undefined;
        setStreaming(undefined);
        refreshContext();
      }
    },
    mode: () => modeRef.current,
    setMode,
    setTheme: props.onTheme,
    setEditorMode,
    editorMode: () => editorModeRef.current,
    clear: props.onClear,
    resume: props.onResume,
    openRewind: () => {
      if (agent.turns.length === 0)
        push({ kind: 'notice', level: 'info', text: 'Nothing to rewind yet.' });
      else setOverlay({ kind: 'rewind' });
    },
    suspend: (fn) => suspendTerminal(fn),
    contextPct: () => contextPct,
    exit: () => {
      onExit(0);
    },
    commands: () => commands,
    sessionTitle: () => titleRef.current,
  });

  const handleSubmit = async (s: Queued & { raw?: boolean }): Promise<void> => {
    if (abortRef.current || pendingRef.current) {
      setQueued((list) => [...list, s]);
      return;
    }
    const text = s.prompt.trim();
    if (s.raw !== true) {
      const slash = text.startsWith('/') ? parseSlash(text) : undefined;
      if (slash) {
        const cmd = findCommand(commands, slash.name);
        if (!cmd) {
          push({
            kind: 'notice',
            level: 'warning',
            text: `Unknown command /${slash.name}. Type / to see the commands.`,
          });
          return;
        }
        try {
          await cmd.run(commandContext(slash.args));
        } catch (err) {
          push({
            kind: 'notice',
            level: 'error',
            text: `/${cmd.name} failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
        refreshContext();
        if (!isBusy()) drainQueue();
        return;
      }
      if (text.startsWith('!')) {
        await runShell(text.slice(1).trim());
        return;
      }
      if (text.startsWith('#')) {
        await saveNote(text.slice(1));
        return;
      }
    }
    const { prompt, attached } = await attachMentions(s.prompt, {
      cwd: runtime.cwd,
      workspace: setup.workspace,
      reads: setup.reads,
    });
    await runTurn({ ...s, prompt });
    if (attached.length > 0) refreshContext();
  };
  const handleSubmitRef = useRef(handleSubmit);
  handleSubmitRef.current = handleSubmit;

  const prompt = usePromptEditor({
    history,
    editorMode: () => editorModeRef.current,
    onSubmit: (s) => void handleSubmitRef.current(s),
    onShortcuts: () => {
      setOverlay({ kind: 'shortcuts' });
    },
  });
  const suggestions = useSuggestions(prompt.editor, commands, files);

  useEffect(() => {
    refreshContext();
    if (initialPrompt !== undefined && initialPrompt.trim() !== '') {
      void handleSubmitRef.current({ prompt: initialPrompt, display: initialPrompt });
    }
    return () => {
      abortRef.current?.abort();
      setup.shell.killAll();
      if (hintTimer.current) clearTimeout(hintTimer.current);
    };
  }, []); // mount only

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
    refreshContext();
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
    const ov = overlayRef.current;
    // prompts, pickers and questions handle their own keys
    if (
      pendingRef.current !== undefined ||
      ov?.kind === 'rewind' ||
      ov?.kind === 'picker' ||
      ov?.kind === 'ask'
    )
      return;
    if (key.ctrl && input === 'd') {
      if (prompt.editorRef.current.value === '') {
        abortRef.current?.abort();
        onExit(0);
      }
      return;
    }
    if (ov?.kind === 'details') {
      if (key.escape || (key.ctrl && input === 'o')) setOverlay(undefined);
      else if (key.upArrow) setDetailsOffset((o) => Math.min(o + 1, Math.max(0, turns.length - 1)));
      else if (key.downArrow) setDetailsOffset((o) => Math.max(0, o - 1));
      return;
    }
    if (ov?.kind === 'shortcuts') {
      setOverlay(undefined);
      if (key.escape || input === '?') return;
    }
    if (key.ctrl && input === 'o') {
      setDetailsOffset(0);
      setOverlay({ kind: 'details' });
      return;
    }
    if (suggestions.items.length > 0 && !abortRef.current) {
      const chosen = suggestions.items[suggestions.index];
      if (key.upArrow || key.downArrow) {
        suggestions.move(key.upArrow ? -1 : 1);
        return;
      }
      if (key.escape) {
        suggestions.dismiss();
        return;
      }
      if ((key.tab || key.return) && chosen && !key.shift) {
        prompt.replaceRange(chosen.start, chosen.end, chosen.text);
        if (key.return && chosen.runOnEnter) {
          setTimeout(() => {
            prompt.submit();
          }, 0);
        }
        return;
      }
    }
    if (key.escape) {
      const double = now() - lastEscAt.current < DOUBLE_ESC_MS;
      lastEscAt.current = now();
      if (abortRef.current) {
        setQueued([]);
        abortRef.current.abort();
      } else if (prompt.isSearching()) {
        prompt.handleKey(input, key);
      } else if (prompt.escapeToNormal()) {
        // vim: INSERT → NORMAL
      } else if (double && prompt.editorRef.current.value !== '') {
        prompt.clear();
      } else if (double && agent.turns.length > 0) {
        setOverlay({ kind: 'rewind' });
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
    const ov = overlayRef.current;
    if (ov !== undefined || pendingRef.current !== undefined) return;
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
      case 'panel':
        return <Panel key={item.id} title={item.title} markdown={item.markdown} width={width} />;
      case 'shell':
        return (
          <ShellEntry
            key={item.id}
            command={item.command}
            output={item.output}
            exitCode={item.exitCode}
          />
        );
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
  const value = prompt.editor.value;
  const tone = value.startsWith('!') ? 'shell' : value.startsWith('#') ? 'memory' : undefined;
  const label =
    tone === 'shell'
      ? '! shell command — runs directly, output goes to VinaX'
      : tone === 'memory'
        ? '# memory note — Enter to choose where to save it'
        : prompt.vimMode === 'normal'
          ? '-- NORMAL --'
          : prompt.vimMode === 'insert'
            ? '-- INSERT --'
            : undefined;
  const promptVisible =
    pending === undefined &&
    overlay?.kind !== 'rewind' &&
    overlay?.kind !== 'picker' &&
    overlay?.kind !== 'ask';
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
            activity={
              streaming.label ??
              (running[0] === undefined ? undefined : `Running ${running[0].name}`)
            }
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
      {overlay?.kind === 'shortcuts' ? <ShortcutsHelp /> : null}
      {overlay?.kind === 'details' ? (
        <TurnDetails
          turns={turns}
          limits={runtime.ledger.entries()}
          offset={detailsOffset}
          height={rows}
          width={width}
        />
      ) : null}
      {overlay?.kind === 'rewind' ? (
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
      {overlay?.kind === 'picker' ? (
        <PickerOverlay title={overlay.title} items={overlay.items} onDone={overlay.resolve} />
      ) : null}
      {overlay?.kind === 'ask' ? (
        <AskOverlay
          title={overlay.title}
          placeholder={overlay.placeholder}
          mask={overlay.mask}
          onDone={overlay.resolve}
        />
      ) : null}
      {promptVisible ? (
        <Box marginTop={1} flexDirection="column">
          <PromptBox
            editor={prompt.editor}
            placeholder={
              busy
                ? 'Type to queue a follow-up · esc to interrupt'
                : 'Ask VinaX anything · / commands · @ files · ! shell · # memory'
            }
            search={prompt.searchView}
            dimmed={busy}
            label={label}
            tone={tone}
          />
          {suggestions.items.length > 0 && !busy ? (
            <Suggestions items={suggestions.items} index={suggestions.index} width={width} />
          ) : null}
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
