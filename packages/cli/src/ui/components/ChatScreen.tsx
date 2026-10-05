import { Box, Static, Text, useApp, useInput, usePaste, useWindowSize } from 'ink';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  attachMentions,
  clipboardImageFile,
  extractImages,
  FileIndex,
  loadImage,
  formatModelRef,
  generateTitle,
  modelAlias,
  parseModelRef,
  costOf,
  formatCost,
  mergeModelUsage,
  priceFor,
  projectDataDir,
  PromptHistory,
  providerLabel,
  totalTokens,
  type ModelUsage,
  type AgentOutcome,
  type AgentSetup,
  type EditorMode,
  type ImageAttachment,
  type PermissionMode,
  type Runtime,
  type SessionWriter,
  type ThemeName,
  type TodoItem,
} from '@vinax/core';
import type { Announcement } from '../../updates.js';
import type { ExitSummary } from '../../exit-summary.js';
import { findCommand } from '../commands/registry.js';
import { parseSlash, type CommandContext, type SlashCommand } from '../commands/types.js';
import { loadChanges } from '../changes.js';
import { formatBytes, truncate } from '../format.js';
import { paletteItems, type PaletteChoice } from '../palette.js';
import { phaseFor, turnSummary } from '../phases.js';
import { performRewind, undoFile, type ReviewDeps } from '../review-actions.js';
import type { TaskState } from '../task-state.js';
import { useTheme } from '../theme.js';
import { browseEntries } from '../transcript-browser.js';
import { createTurnTracker, outcomeItem, type Running, type Streaming } from '../turn-events.js';
import { type NewTranscriptItem, type TranscriptItem, type TurnRecord } from '../transcript.js';
import { useAgentHost } from '../use-agent-host.js';
import { ownsKeyboard, useOverlays } from '../use-overlays.js';
import { usePromptEditor, type Submission } from '../use-prompt-editor.js';
import { useRefState } from '../use-ref-state.js';
import { useSuggestions } from '../use-suggestions.js';
import { ActivityIndicator } from './ActivityIndicator.js';
import { ChangesView } from './ChangesView.js';
import { AssistantMarkdown } from './Messages.js';
import { AskOverlay, PickerOverlay } from './Overlays.js';
import { PermissionPrompt } from './PermissionPrompt.js';
import { PlanPrompt } from './PlanPrompt.js';
import { QuestionPrompt } from './QuestionPrompt.js';
import { PromptBox } from './PromptBox.js';
import { RewindPicker } from './RewindPicker.js';
import { ShortcutsHelp } from './ShortcutsHelp.js';
import { SettingsPanel } from './SettingsPanel.js';
import { SnakeGame } from './SnakeGame.js';
import { MODE_CYCLE, MODE_DESCRIPTIONS, StatusLine, type StatusNotice } from './StatusLine.js';
import { Suggestions } from './Suggestions.js';
import { TodoList } from './TodoList.js';
import { RunningTool } from './ToolEntry.js';
import { TranscriptBrowser } from './TranscriptBrowser.js';
import { TranscriptEntry } from './TranscriptEntry.js';
import { Welcome } from './Welcome.js';

/** Rotating example prompts for the empty prompt box, like Claude Code's `Try "…"`. */
const PLACEHOLDERS: readonly string[] = [
  'Try "explain how this project is structured"',
  'Try "fix the failing tests"',
  'Try "review my changes"',
  'Try "write a test for @src/…"',
  'Try "what changed in the last commit?"',
];
const EXIT_WINDOW_MS = 2000;
const DOUBLE_ESC_MS = 600;
const SHELL_CONTEXT_CHARS = 6000;

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
  /** Loaded after the first paint: what's new, update available. */
  announcements?: (() => Promise<Announcement[]>) | undefined;
  editorMode: EditorMode;
  onExit: (code: number, summary?: ExitSummary) => void;
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
  const push = (item: NewTranscriptItem): number => {
    const id = nextId.current++;
    session.record({ type: 'view', data: item });
    setItems((prev) => [...prev, { ...item, id }]);
    return id;
  };
  /** Full output of this session's tool calls, by transcript item id (for Ctrl+O). */
  const toolOutputs = useRef(new Map<number, string>());

  const [streaming, setStreaming] = useState<Streaming | undefined>(undefined);
  const [running, setRunning] = useState<Running[]>([]);
  const [queued, setQueued, queuedRef] = useRefState<Queued[]>([]);
  const { overlay, overlayRef, setOverlay, pick, ask, editSettings, playSnake } = useOverlays();
  const [mode, setMode, modeRef] = useRefState<PermissionMode>(
    runtime.settings.resolved.permissions.defaultMode,
  );
  /** How the last turn ended, for the status line (cleared when the next one starts). */
  const [lastOutcome, setLastOutcome] = useState<
    { status: AgentOutcome['status']; durationMs: number } | undefined
  >(undefined);
  const [, setEditorMode, editorModeRef] = useRefState<EditorMode>(props.editorMode);
  const [notice, setNotice] = useState<StatusNotice | undefined>(undefined);
  const [hint, setHint] = useState<string | undefined>(undefined);
  const [turns, setTurns, turnsRef] = useRefState<TurnRecord[]>([]);
  const [activeModel, setActiveModel] = useState(agent.model ?? runtime.settings.resolved.model);
  const [contextPct, setContextPct] = useState<number | undefined>(undefined);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [, setTitle, titleRef] = useRefState<string | undefined>(props.title);

  const abortRef = useRef<AbortController | undefined>(undefined);
  const mountedAt = useRef(now());
  /** Files edited this session and lines added/removed, for the exit summary. */
  const changes = useRef({ files: new Set<string>(), added: 0, removed: 0 });
  const [exiting, setExiting] = useState(false);
  /** Images pasted with Ctrl+V, by their `[Image #n]` number, until the prompt is sent. */
  const pendingImages = useRef(new Map<number, ImageAttachment>());
  const nextImage = useRef(1);
  const placeholder = useMemo(
    () => PLACEHOLDERS[Math.floor(Math.random() * PLACEHOLDERS.length)] ?? PLACEHOLDERS[0],
    [],
  );
  /** The answer text still streaming in (see createTurnTracker). */
  const streamRef = useRef({ tail: '', committed: false });
  const exitArmedAt = useRef<number | undefined>(undefined);
  const lastEscAt = useRef(0);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const history = useMemo(
    () => PromptHistory.forProject(projectDataDir(runtime.cwd, runtime.env)),
    [runtime],
  );
  const files = useMemo(() => new FileIndex(runtime.cwd), [runtime]);

  useEffect(() => setup.todos.subscribe(setTodos), [setup]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const { host, pending, pendingRef, backlog } = useAgentHost({
    runtime,
    modeRef,
    setMode,
    onRuleSaved: (rule, file) => {
      push({ kind: 'notice', level: 'info', text: `Saved ${rule} to ${file}` });
    },
    now,
  });

  /** Leaves like Claude Code: the prompt disappears and a session summary is printed. */
  const leave = (code = 0): void => {
    if (exiting) return;
    const t = turnsRef.current;
    const summary: ExitSummary = {
      sessionId: session.id,
      title: titleRef.current,
      prompts: t.length,
      toolCalls: t.reduce((n, x) => n + x.tools.length, 0),
      wallMs: now() - mountedAt.current,
      activeMs: t.reduce((n, x) => n + x.durationMs, 0),
      inputTokens: t.reduce((n, x) => n + (x.inputTokens ?? 0), 0),
      outputTokens: t.reduce((n, x) => n + (x.outputTokens ?? 0), 0),
      estimatedTokens: t.reduce((n, x) => n + (x.estimatedTokens ?? 0), 0),
      ...(t.some((x) => Object.keys(x.usageByModel ?? {}).length > 0)
        ? { cost: formatCost(sessionCost()) }
        : {}),
      filesChanged: changes.current.files.size,
      linesAdded: changes.current.added,
      linesRemoved: changes.current.removed,
      models: [...new Set(t.map((x) => x.model).filter((m): m is string => m !== undefined))],
    };
    setExiting(true);
    // let Ink paint one last frame without the prompt, then hand over to the summary
    setTimeout(() => {
      onExit(code, summary);
    }, 30);
  };

  /** Tokens per model this session, and what they cost where prices are known. */
  const sessionUsage = (): Record<string, ModelUsage> => {
    const byModel: Record<string, ModelUsage> = {};
    for (const t of turnsRef.current) mergeModelUsage(byModel, t.usageByModel ?? {});
    return byModel;
  };
  const sessionCost = () =>
    costOf(sessionUsage(), (ref) => priceFor(ref, runtime.settings.resolved, runtime.models));

  const refreshContext = (): void => {
    const limit = setup.contextLimit();
    setContextPct(
      Number.isFinite(limit)
        ? Math.min(100, Math.round((agent.requestTokens(modeRef.current) / limit) * 100))
        : undefined,
    );
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

  const runTurn = async (q: Queued & { images?: ImageAttachment[] }): Promise<void> => {
    push({ kind: 'user', text: q.display });
    if (q.images !== undefined && q.images.length > 0) {
      push({
        kind: 'notice',
        level: 'info',
        text: `Attached ${q.images.map((img, i) => `[Image #${String(i + 1)}] ${img.name ?? img.mediaType} (${formatBytes((img.data.length * 3) / 4)})`).join(', ')}`,
      });
    }
    const ac = new AbortController();
    abortRef.current = ac;
    streamRef.current = { tail: '', committed: false };
    const startedAt = now();
    setNotice(undefined);
    setLastOutcome(undefined);
    setStreaming({ startedAt, tail: '', chars: 0, committed: false, waiting: undefined });
    const tracker = createTurnTracker({
      push,
      setStreaming,
      setRunning,
      setNotice,
      setActiveModel,
      toolOutputs: toolOutputs.current,
      changes: changes.current,
      stream: streamRef.current,
      now,
    });

    const outcome = await agent.run(q.prompt, {
      signal: ac.signal,
      host,
      onEvent: tracker.onEvent,
      ...(q.allowRules === undefined ? {} : { allowRules: q.allowRules }),
      ...(q.model === undefined ? {} : { model: q.model }),
      ...(q.images === undefined || q.images.length === 0 ? {} : { images: q.images }),
    });
    tracker.endThinking();
    abortRef.current = undefined;
    tracker.commitTail();
    setRunning([]);
    const ended = outcomeItem(outcome);
    if (ended !== undefined) push(ended);
    const { tools } = tracker;
    if (outcome.status === 'done' && tools.length > 0) {
      push({ kind: 'summary', text: turnSummary(tools, now() - startedAt) });
    }
    setStreaming(undefined);
    setLastOutcome({ status: outcome.status, durationMs: now() - startedAt });
    setTurns((t) => [
      ...t,
      {
        prompt: q.display,
        model: tracker.model,
        inputTokens: outcome.usage.promptTokens || undefined,
        outputTokens: outcome.usage.completionTokens || undefined,
        estimatedTokens: totalTokens(outcome.estimatedUsage) || undefined,
        usageByModel: outcome.usageByModel,
        durationMs: now() - startedAt,
        fallbacks: tracker.fallbacks,
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
    editSettings,
    playSnake,
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
    openChanges: () => {
      setOverlay({ kind: 'changes' });
    },
    suspend: (fn) => suspendTerminal(fn),
    contextPct: () => contextPct,
    exit: () => {
      leave();
    },
    commands: () => commands,
    sessionTitle: () => titleRef.current,
    sessionUsage,
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
            text: `Unknown command /${slash.name}. Type / to see the commands, or press Ctrl+P to search them.`,
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
    // Images: pasted with Ctrl+V (chips already in the text) or given as paths / @file.png.
    const pasted = [...pendingImages.current.entries()].filter(([n]) =>
      s.prompt.includes(`[Image #${String(n)}]`),
    );
    pendingImages.current.clear();
    const found = await extractImages(s.prompt, runtime.cwd, nextImage.current);
    for (const err of found.errors) push({ kind: 'notice', level: 'warning', text: err });
    nextImage.current += found.images.length;
    const images = [...pasted.map(([, img]) => img), ...found.images];
    const display = s.display === s.prompt ? found.text : s.display;
    const { prompt, attached } = await attachMentions(found.text, {
      cwd: runtime.cwd,
      workspace: setup.workspace,
      reads: setup.reads,
    });
    await runTurn({ ...s, prompt, display, images });
    nextImage.current = 1;
    if (attached.length > 0) refreshContext();
  };
  const handleSubmitRef = useRef(handleSubmit);
  handleSubmitRef.current = handleSubmit;

  const pasteImage = async (): Promise<void> => {
    const file = await clipboardImageFile();
    if (file === undefined) {
      flashHint('No image on the clipboard (Cmd+V pastes text; drag a file in to attach it)');
      return;
    }
    try {
      const img = await loadImage(file);
      const n = nextImage.current++;
      pendingImages.current.set(n, { ...img, name: `clipboard-${String(n)}.png` });
      prompt.insertText(`[Image #${String(n)}] `);
    } catch (err) {
      flashHint(err instanceof Error ? err.message : String(err));
    }
  };

  const prompt = usePromptEditor({
    history,
    editorMode: () => editorModeRef.current,
    onSubmit: (s) => void handleSubmitRef.current(s),
    onShortcuts: () => {
      setOverlay({ kind: 'shortcuts' });
    },
    onPasteImage: () => void pasteImage(),
    onRedraw: () => {
      void suspendTerminal(() => {
        process.stdout.write('\x1b[2J\x1b[H');
      });
    },
  });
  const suggestions = useSuggestions(prompt.editor, commands, files);

  useEffect(() => {
    refreshContext();
    void props
      .announcements?.()
      .then((list) => {
        for (const a of list) {
          if (a.kind === 'panel') push({ kind: 'panel', title: a.title, markdown: a.markdown });
          else push({ kind: 'notice', level: a.level, text: a.text });
        }
      })
      .catch(() => undefined);
    if (initialPrompt !== undefined && initialPrompt.trim() !== '') {
      void handleSubmitRef.current({ prompt: initialPrompt, display: initialPrompt });
    }
    return () => {
      abortRef.current?.abort();
      void setup.close();
      if (hintTimer.current) clearTimeout(hintTimer.current);
    };
  }, []); // mount only

  const reviewDeps: ReviewDeps = {
    agent,
    checkpoints,
    cwd: runtime.cwd,
    notify: (level, text) => {
      push({ kind: 'notice', level, text });
    },
    setPrompt: (text) => {
      prompt.setText(text);
    },
  };

  /** Ctrl+P: every view and slash command, searchable. */
  const openPalette = async (): Promise<void> => {
    const choice = await pick<PaletteChoice>('Command palette', paletteItems(commands), {
      searchable: true,
    });
    if (choice === undefined) return;
    if (choice.kind === 'command') {
      if (choice.needsArgs) prompt.setText(`/${choice.name} `);
      else void handleSubmitRef.current({ prompt: `/${choice.name}`, display: `/${choice.name}` });
      return;
    }
    switch (choice.id) {
      case 'changes':
        setOverlay({ kind: 'changes' });
        return;
      case 'transcript':
        setOverlay({ kind: 'transcript' });
        return;
      case 'rewind':
        if (agent.turns.length === 0)
          push({ kind: 'notice', level: 'info', text: 'Nothing to rewind yet.' });
        else setOverlay({ kind: 'rewind' });
        return;
      case 'mode':
        cycleMode();
        return;
      case 'shortcuts':
        setOverlay({ kind: 'shortcuts' });
        return;
    }
  };

  /** Shift+Tab: next permission mode; a pending approval the new mode allows is granted. */
  const cycleMode = (): void => {
    const request = pendingRef.current;
    const next =
      MODE_CYCLE[(MODE_CYCLE.indexOf(modeRef.current) + 1) % MODE_CYCLE.length] ?? 'default';
    setMode(next);
    setNotice({ level: 'info', text: MODE_DESCRIPTIONS[next] });
    if (request?.kind === 'permission') {
      if (next === 'plan') {
        abortRef.current?.abort();
      } else {
        const tool = setup.tools.find((t) => t.name === request.req.tool);
        if (tool && abortRef.current) {
          const target = tool.target(request.req.input, {
            cwd: runtime.cwd,
            workspace: setup.workspace,
            shell: setup.shell,
            reads: setup.reads,
            signal: abortRef.current.signal,
          });
          const decision = setup.permissions.decide(
            {
              name: tool.name,
              kind: tool.kind,
              readOnly: tool.readOnly,
              target,
            },
            next,
          );
          if (decision.kind === 'allow') request.resolve({ kind: 'allow' });
        }
      }
    }
    refreshContext();
  };

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      const armed =
        exitArmedAt.current !== undefined && now() - exitArmedAt.current < EXIT_WINDOW_MS;
      if (armed) {
        abortRef.current?.abort();
        leave();
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
    if (key.tab && key.shift && ov === undefined) {
      const request = pendingRef.current;
      if (request !== undefined && request.kind !== 'permission') {
        flashHint('Answer or cancel the current question first');
        return;
      }
      cycleMode();
      return;
    }
    // prompts, pickers, questions and views handle their own keys
    if (pendingRef.current !== undefined || ownsKeyboard(ov)) return;
    if (key.ctrl && input === 'd') {
      if (prompt.editorRef.current.value === '') {
        abortRef.current?.abort();
        leave();
      }
      return;
    }
    if (ov?.kind === 'shortcuts') {
      setOverlay(undefined);
      if (key.escape || input === '?') return;
    }
    if (key.ctrl && input === 'o') {
      setOverlay({ kind: 'transcript' });
      return;
    }
    if (key.ctrl && input === 'g') {
      setOverlay({ kind: 'changes' });
      return;
    }
    if (key.ctrl && input === 'p') {
      void openPalette();
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
    prompt.handleKey(input, key);
  });

  usePaste((text) => {
    const ov = overlayRef.current;
    if (ov !== undefined || pendingRef.current !== undefined) return;
    prompt.handlePaste(text);
  });

  const modelRef = parseModelRef(activeModel);
  const welcome = () => (
    <Welcome
      version={version}
      cwd={runtime.cwd}
      model={modelRef.model}
      provider={`${providerLabel(modelRef.provider)}${runtime.viaGateway.has(modelRef.provider) ? ' (VinaX gateway)' : ''}`}
      alias={modelAlias(formatModelRef(modelRef))}
      branch={setup.git?.branch}
      session={
        (props.restored ?? []).length > 0
          ? `resumed · ${props.title ?? 'untitled session'}`
          : 'new session'
      }
      memory={setup.memory.files}
      tips={runtime.settings.resolved.showTips ? tips : []}
      width={width}
      env={runtime.env}
    />
  );
  const renderItem = (item: TranscriptItem) => (
    <TranscriptEntry key={item.id} item={item} width={width} welcome={welcome} />
  );

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
  const promptVisible = pending === undefined && !ownsKeyboard(overlay);
  const task: TaskState =
    pending !== undefined
      ? {
          kind: 'waiting',
          since: pending.since,
          what: pending.kind === 'permission' ? 'approval' : pending.kind,
          more: backlog,
        }
      : streaming !== undefined
        ? {
            kind: 'running',
            since: streaming.startedAt,
            ...(runtime.settings.resolved.budget.tokens === undefined ||
            streaming.label !== undefined
              ? {}
              : {
                  tokens: {
                    used: streaming.tokens ?? 0,
                    budget: runtime.settings.resolved.budget.tokens,
                  },
                }),
          }
        : lastOutcome !== undefined
          ? { kind: 'ended', ...lastOutcome }
          : { kind: 'idle' };
  if (exiting) {
    return (
      <Box flexDirection="column">
        <Static items={items}>{renderItem}</Static>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Static items={items}>{renderItem}</Static>
      {streaming !== undefined && streaming.tail.trim() !== '' ? (
        <AssistantMarkdown
          markdown={streaming.tail}
          first={!streaming.committed}
          width={width}
          maxLines={Math.max(3, rows - 16)}
        />
      ) : null}
      {running.slice(-2).map((r) => (
        <RunningTool
          key={r.id}
          name={r.name}
          label={r.label}
          output={r.output}
          width={width}
          active={pending === undefined}
        />
      ))}
      {pending?.kind === 'permission' ? (
        <PermissionPrompt
          key={pending.id}
          req={pending.req}
          width={width}
          onAnswer={pending.resolve}
          onAcceptEdits={() => {
            setMode('acceptEdits');
          }}
        />
      ) : null}
      {pending?.kind === 'plan' ? (
        <PlanPrompt key={pending.id} plan={pending.plan} width={width} onDecide={pending.resolve} />
      ) : null}
      {pending?.kind === 'question' ? (
        <QuestionPrompt key={pending.id} question={pending.question} onAnswer={pending.resolve} />
      ) : null}
      {busy && pending === undefined ? (
        <Box marginTop={1}>
          <ActivityIndicator
            startedAt={streaming.startedAt}
            outputChars={streaming.chars}
            waiting={streaming.waiting}
            activity={
              streaming.label ??
              (running[0] === undefined ? undefined : phaseFor(running[0].name, running[0].label))
            }
            trail={streaming.trail ?? []}
            thinking={streaming.thinking}
            effort={agent.effort}
            width={width}
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
      {overlay?.kind === 'settings' ? (
        <SettingsPanel
          title={overlay.title}
          rows={overlay.rows}
          onChange={overlay.onChange}
          onClose={overlay.resolve}
        />
      ) : null}
      {overlay?.kind === 'snake' ? (
        <SnakeGame columns={width} rows={rows} best={overlay.best} onExit={overlay.resolve} />
      ) : null}
      {overlay?.kind === 'transcript' ? (
        <TranscriptBrowser
          entries={browseEntries(items, turns, toolOutputs.current)}
          limits={runtime.ledger.entries()}
          height={rows}
          width={width}
          onClose={() => {
            setOverlay(undefined);
          }}
        />
      ) : null}
      {overlay?.kind === 'changes' ? (
        <ChangesView
          load={() => loadChanges(checkpoints, runtime.cwd)}
          undo={(row, resolution) =>
            busy
              ? Promise.resolve(
                  'VinaX is still working. Wait for it to finish (or press Ctrl+C to stop it) before undoing a file.',
                )
              : undoFile(reviewDeps, row, resolution)
          }
          height={rows}
          width={width}
          onClose={() => {
            setOverlay(undefined);
            refreshContext();
          }}
        />
      ) : null}
      {overlay?.kind === 'rewind' ? (
        <RewindPicker
          targets={agent.turns.map((t) => ({
            turn: t.turn,
            prompt: t.prompt,
            changedFiles: checkpoints.changedSince(t.turn).length,
            shellCommands: agent.shellCommandsSince(t.turn),
          }))}
          width={width}
          cwd={runtime.cwd}
          plan={(turn) => checkpoints.planRestore(turn)}
          onDone={(c) => {
            setOverlay(undefined);
            if (c !== undefined)
              void performRewind(reviewDeps, c).then(() => {
                refreshContext();
              });
          }}
        />
      ) : null}
      {overlay?.kind === 'picker' ? (
        <PickerOverlay
          title={overlay.title}
          items={overlay.items}
          searchable={overlay.searchable}
          onDone={overlay.resolve}
        />
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
              busy ? 'Type to queue a follow-up · esc to interrupt' : (placeholder ?? '')
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
        effort={agent.effort}
        model={activeModel}
        contextPct={contextPct}
        notice={notice}
        hint={
          hint ?? (pending === undefined ? undefined : 'Waiting for your answer · Ctrl+C to stop')
        }
        task={task}
        queued={queued.length}
        now={now}
        width={width}
      />
    </Box>
  );
}
