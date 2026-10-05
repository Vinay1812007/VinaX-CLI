import type { PermissionMode } from '../config/schema.js';
import type { PermissionEngine } from '../permissions/engine.js';
import {
  formatModelRef,
  parseModelRef,
  type ChatMessage,
  type ImageAttachment,
  type ModelRef,
  type ReasoningEffort,
  type ToolCall,
  type Usage,
} from '../providers/types.js';
import { estimateTokens } from '../context/tokens.js';
import { AbortError } from '../router/backoff.js';
import { explainError, type FailureReport } from '../router/explain.js';
import type { Router, RouterEvent } from '../router/router.js';
import type { PlanDecision } from '../tools/plan-tool.js';
import type { UserAnswer, UserQuestion } from '../tools/question-tool.js';
import { addUsage, emptyUsage, totalTokens, type ModelUsage } from '../state/cost.js';
import { describeInvalidArgs, toolSpec } from '../tools/registry.js';
import {
  TIME_BUDGET_ABORT,
  type AnyTool,
  type ToolContext,
  type ToolDisplay,
  type ToolKind,
  type ToolOutput,
} from '../tools/types.js';
import type { LoadedSession, SessionRecorder, TurnMark } from '../session/store.js';
import type { HookRunner } from '../hooks/runner.js';
import type { CheckpointStore } from './checkpoints.js';
import { LoopGuard, STUCK_ADVICE } from './loop-guard.js';
import {
  applySummary,
  elideToolOutputs,
  safeTailStart,
  summarize,
  userRequests,
} from './compact.js';
import {
  TextCallParser,
  textProtocolInstructions,
  tidyVisibleText,
  toTextProtocol,
} from './text-protocol.js';

export const INTERRUPTED_MARKER = '[interrupted by the user]';
/** Malformed native tool calls tolerated per model before switching it to the text protocol. */
const MALFORMED_LIMIT = 2;

export type ToolMode = 'native' | 'text';

/** Reads the flag through a call so TypeScript does not narrow it across awaits. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

export interface PermissionRequest {
  callId: string;
  tool: string;
  kind: ToolKind;
  label: string;
  input: unknown;
  reason: string;
  danger?: string;
  suggestion?: string;
  preview?: ToolDisplay;
}

export type PermissionAnswer =
  | { kind: 'allow' }
  | { kind: 'allow_rule'; rule: string; scope: 'session' | 'project' }
  | { kind: 'deny'; feedback: string }
  /** Nobody can approve (headless runs): the call fails with `message` and the turn goes on. */
  | { kind: 'unavailable'; message: string };

export interface AgentHost {
  mode(): PermissionMode;
  /** Shows an approval prompt. Should reject (or resolve deny) when `signal` aborts. */
  askPermission(req: PermissionRequest, signal: AbortSignal): Promise<PermissionAnswer>;
  /** Omit when nobody can approve plans (headless runs). */
  approvePlan?: (plan: string, signal: AbortSignal) => Promise<PlanDecision>;
  askQuestion?: (question: UserQuestion, signal: AbortSignal) => Promise<UserAnswer>;
  /** Saves an allow rule for this project (in `.vinax/settings.local.json`). */
  saveProjectRule?: (rule: string) => Promise<void>;
}

export type AgentEvent =
  | Exclude<RouterEvent, { type: 'tool_call_delta' }>
  | { type: 'tool_call'; id: string; name: string; label: string; input: unknown }
  | { type: 'tool_progress'; id: string; chunk: string }
  | {
      type: 'tool_result';
      id: string;
      name: string;
      ok: boolean;
      summary: string;
      content: string;
      display?: ToolDisplay;
    }
  | { type: 'notice'; level: 'info' | 'warning'; text: string }
  /** The conversation was shrunk: `elide` drops old tool output, `summary` condenses history. */
  | { type: 'compact'; kind: 'elide' | 'summary'; before: number; after: number };

export interface AgentOutcome {
  /**
   * `budget`: the task reached its token or time budget. `stuck`: it was going in circles
   * (the same call failing or repeating); `error` explains and says what to do next.
   */
  status:
    'done' | 'interrupted' | 'failed' | 'max_turns' | 'declined' | 'blocked' | 'budget' | 'stuck';
  /** The final assistant text of the turn. */
  text: string;
  error?: string;
  /** For `failed` turns: the failure explained, with actions to try. */
  report?: FailureReport;
  steps: number;
  /** Tokens the providers reported (sub-agents included). */
  usage: Usage;
  /** Tokens VinaX estimated for responses without a usage report (or cut off mid-stream). */
  estimatedUsage: Usage;
  /** Both, per model ref, for pricing. */
  usageByModel: Record<string, ModelUsage>;
  models: string[];
}

/** Per-task limits; either may be unset. */
export interface TaskBudget {
  tokens?: number | undefined;
  seconds?: number | undefined;
}

export interface AgentDeps {
  router: Router;
  tools: readonly AnyTool[];
  permissions: PermissionEngine;
  context: Omit<ToolContext, 'signal' | 'onProgress'>;
  checkpoints: CheckpointStore;
  systemPrompt: (mode: PermissionMode, toolInstructions?: string) => string;
  /** From the model catalog: `false` means the model has no native tool calling. */
  supportsTools?: (ref: ModelRef) => boolean | undefined;
  /** Whether a model accepts images; images are replaced by a note for models that do not. */
  supportsVision?: (ref: ModelRef) => boolean;
  /** Vision-capable models, best first, to answer turns that carry images. */
  visionModels?: () => string[];
  /** The settings' main model, used when no model was chosen for the session. */
  defaultModel?: () => string;
  /** Model calls allowed per user turn. */
  maxTurns?: number;
  /** Head of the fallback chain (e.g. `--model`). */
  model?: string;
  /** Default reasoning effort (settings `reasoningEffort`). */
  effort?: ReasoningEffort;
  /** Persists the conversation (session transcript). */
  recorder?: SessionRecorder;
  /** Token budget for the conversation; auto-compaction starts at 85% of it. */
  contextLimit?: () => number;
  /** Instructions discovered when a tool first touches a folder (nested VINAX.md). */
  onPathTouched?: (file: string) => string | undefined;
  hooks?: HookRunner;
  /** A sub-agent: no turn marks, checkpoints turns or prompt/stop hooks of its own. */
  nested?: boolean;
  /** Open items of the task list, carried verbatim through compaction. */
  activeTasks?: () => string | undefined;
  /** Token and time limits for each task (read when a task starts). */
  budget?: () => TaskBudget;
  /** A model's context window, when its catalog says (for warnings before a request). */
  contextWindow?: (ref: ModelRef) => number | undefined;
}

/** What one task has used and how it is going, shared by its steps. */
class TaskState {
  readonly byModel: Record<string, ModelUsage> = {};
  readonly guard = new LoopGuard();
  /** Set when a budget ran out: why, for the user. */
  budgetHit: string | undefined;
  /** Set when the task is going in circles: why, for the user. */
  stuck: string | undefined;

  private slot(ref: string): ModelUsage {
    return (this.byModel[ref] ??= { measured: emptyUsage(), estimated: emptyUsage() });
  }

  measured(ref: string, u: Usage): void {
    addUsage(this.slot(ref).measured, u);
  }

  estimated(ref: string, u: Usage): void {
    addUsage(this.slot(ref).estimated, u);
  }

  totals(): { measured: Usage; estimated: Usage } {
    const measured = emptyUsage();
    const estimated = emptyUsage();
    for (const u of Object.values(this.byModel)) {
      addUsage(measured, u.measured);
      addUsage(estimated, u.estimated);
    }
    return { measured, estimated };
  }

  total(): number {
    const t = this.totals();
    return totalTokens(t.measured) + totalTokens(t.estimated);
  }

  /** Why work is being stopped, for "Not run: …" notes. */
  why(): string {
    return this.budgetHit === undefined
      ? 'the user interrupted'
      : 'the task reached its time budget';
  }
}

function kTokens(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
}

/** How many times a Stop hook may send the model back to work in one turn. */
const MAX_STOP_HOOK_RETRIES = 3;

/** Auto-compaction starts when the request reaches this share of the context budget. */
const COMPACT_AT = 0.85;

interface Prepared {
  call: ToolCall;
  tool: AnyTool | undefined;
  input: unknown;
  error: string | undefined;
}

/** Everything the loop needs to run one user turn. */
interface RunOptions {
  signal: AbortSignal;
  host: AgentHost;
  onEvent: (ev: AgentEvent) => void;
  /** Extra allow rules for this turn only (custom command `allowed-tools`). */
  allowRules?: readonly string[];
  /** Model for this turn only (custom command `model`). */
  model?: string;
  /** Fallbacks for this turn only, replacing the settings' chain (other vision models). */
  fallbacks?: readonly string[];
  /** Images attached to the prompt (pasted, dragged in or `@image.png`). */
  images?: readonly ImageAttachment[];
}

type StepOptions = RunOptions & { task: TaskState };

/**
 * The agent loop: stream a reply, collect tool calls (native or text protocol), check
 * permissions, run the tools, feed results back, and repeat until the model stops calling tools.
 */
export class Agent {
  readonly messages: ChatMessage[] = [];
  private readonly toolModes = new Map<string, ToolMode>();
  private readonly malformed = new Map<string, number>();
  private readonly marks: TurnMark[] = [];
  private turnCounter = 0;
  /**
   * Where the task in progress starts in `messages`. Kept apart from the rewind marks, which
   * compaction clears, so a second compaction in the same task keeps the task's own messages.
   */
  private taskStart: number | undefined;

  constructor(private readonly deps: AgentDeps) {}

  private push(...messages: ChatMessage[]): void {
    for (const m of messages) {
      this.messages.push(m);
      this.deps.recorder?.record({ type: 'message', message: m });
    }
  }

  private truncate(messageCount: number, turnsKept: number): void {
    this.messages.length = Math.min(this.messages.length, messageCount);
    this.marks.length = Math.min(this.marks.length, turnsKept);
    this.deps.recorder?.record({ type: 'truncate', messageCount, turnsKept });
  }

  /** Replaces the whole conversation (after compaction); earlier turns can no longer be rewound. */
  private reset(messages: ChatMessage[]): void {
    this.messages.length = 0;
    this.messages.push(...messages);
    this.marks.length = 0;
    this.deps.recorder?.record({ type: 'reset', messages, keepMarks: false });
  }

  /** Continues a saved session. */
  restore(session: Pick<LoadedSession, 'messages' | 'marks'>): void {
    this.messages.length = 0;
    this.messages.push(...session.messages);
    this.marks.length = 0;
    this.marks.push(...session.marks);
    this.turnCounter = Math.max(0, ...session.marks.map((m) => m.turn));
  }

  private modelOverride: string | undefined;
  private effortOverride: ReasoningEffort | undefined;

  /** Head of the fallback chain for later turns (`/model`); `undefined` returns to the default. */
  /** Reasoning effort for this session (`undefined` = the model's default). */
  setEffort(effort: ReasoningEffort | undefined): void {
    this.effortOverride = effort;
  }

  get effort(): ReasoningEffort | undefined {
    return this.effortOverride ?? this.deps.effort;
  }

  setModel(model: string | undefined): void {
    this.modelOverride = model;
  }

  get model(): string | undefined {
    return this.modelOverride ?? this.deps.model;
  }

  /** Estimated tokens of the next request in `mode`. */
  requestTokens(mode: PermissionMode): number {
    const specs = this.deps.tools
      .filter((t) => (mode === 'plan' ? t.readOnly : t.name !== 'ExitPlanMode'))
      .map(toolSpec);
    return estimateTokens(
      [{ role: 'system', content: this.deps.systemPrompt(mode) }, ...this.messages],
      specs,
    );
  }

  /**
   * Shrinks the conversation. Old tool outputs are elided first (free); if that is not enough —
   * or when `force` is set (/compact) — history before the current turn is summarized by the
   * small model. Returns undefined when there was nothing to do.
   */
  async compact(opts: {
    mode: PermissionMode;
    signal: AbortSignal;
    force?: boolean;
    instructions?: string;
    inTurn?: boolean;
    onEvent?: (ev: AgentEvent) => void;
  }): Promise<{ before: number; after: number } | undefined> {
    const limit = this.deps.contextLimit?.() ?? Number.POSITIVE_INFINITY;
    const target = limit * COMPACT_AT;
    const before = this.requestTokens(opts.mode);
    if (opts.force !== true && before <= target) return undefined;
    if (opts.force !== true) {
      const elided = elideToolOutputs(this.messages);
      if (elided.elided > 0) {
        this.rewrite(elided.messages);
        const after = this.requestTokens(opts.mode);
        opts.onEvent?.({ type: 'compact', kind: 'elide', before, after });
        if (after <= target) return { before, after };
      }
    }
    const start = opts.inTurn === true ? this.taskStart : undefined;
    let tailStart = safeTailStart(this.messages, start ?? this.messages.length);
    if (estimateTokens(this.messages.slice(tailStart)) > limit * 0.5)
      tailStart = this.messages.length;
    const head = this.messages.slice(0, tailStart);
    if (head.length === 0) return undefined;
    const summary = await summarize(this.deps.router, head, {
      signal: opts.signal,
      ...(opts.instructions === undefined ? {} : { instructions: opts.instructions }),
    });
    const keptTail = tailStart < this.messages.length;
    this.reset(
      applySummary(summary, this.messages.slice(tailStart), {
        requests: userRequests(head),
        tasks: this.deps.activeTasks?.(),
      }),
    );
    // the task's prompt is now the first message (with the summary folded in)
    if (opts.inTurn === true) this.taskStart = keptTail ? 0 : undefined;
    const after = this.requestTokens(opts.mode);
    opts.onEvent?.({ type: 'compact', kind: 'summary', before, after });
    return { before, after };
  }

  /** Replaces message contents without changing their number (tool-output elision). */
  private rewrite(messages: ChatMessage[]): void {
    this.messages.length = 0;
    this.messages.push(...messages);
    this.deps.recorder?.record({ type: 'reset', messages, keepMarks: true });
  }

  /** Adds context the user produced outside a turn (e.g. `!` shell output). */
  addContext(text: string): void {
    this.push({ role: 'user', content: text });
  }

  /** User turns that can be rewound to, oldest first. */
  get turns(): readonly TurnMark[] {
    return this.marks;
  }

  modeFor(ref: ModelRef): ToolMode {
    return (
      this.toolModes.get(formatModelRef(ref)) ??
      (this.deps.supportsTools?.(ref) === false ? 'text' : 'native')
    );
  }

  private useTextProtocol(ref: ModelRef, onEvent: RunOptions['onEvent'], why: string): boolean {
    const key = formatModelRef(ref);
    if (this.toolModes.get(key) === 'text') return false;
    this.toolModes.set(key, 'text');
    onEvent({
      type: 'notice',
      level: 'info',
      text: `${key} ${why}; switching it to VinaX's text tool protocol.`,
    });
    return true;
  }

  /**
   * Shell commands the agent ran from `turn` on. Their effects are not checkpointed, so rewind
   * cannot undo them.
   */
  shellCommandsSince(turn: number): number {
    const mark = this.marks.find((m) => m.turn === turn);
    if (!mark) return 0;
    return this.messages
      .slice(mark.messageIndex)
      .reduce(
        (n, m) =>
          n +
          (m.role === 'assistant'
            ? (m.toolCalls ?? []).filter((c) => c.name === 'Bash').length
            : 0),
        0,
      );
  }

  /** Drops the conversation from `turn` on and returns that turn's prompt. */
  rewindConversation(turn: number): string | undefined {
    const idx = this.marks.findIndex((m) => m.turn === turn);
    const mark = this.marks[idx];
    if (!mark) return undefined;
    this.truncate(mark.messageIndex, idx);
    return mark.prompt;
  }

  private warn(onEvent: RunOptions['onEvent'], warnings: readonly string[]): void {
    for (const text of warnings) onEvent({ type: 'notice', level: 'warning', text });
  }

  async run(prompt: string, runOpts: RunOptions): Promise<AgentOutcome> {
    const task = new TaskState();
    const models = new Set<string>();
    let steps = 0;
    let lastText = '';
    const outcome = (
      status: AgentOutcome['status'],
      error?: string,
      report?: FailureReport,
    ): AgentOutcome => {
      const { measured, estimated } = task.totals();
      return {
        status,
        text: lastText,
        steps,
        usage: measured,
        estimatedUsage: estimated,
        usageByModel: task.byModel,
        models: [...models],
        ...(error === undefined ? {} : { error }),
        ...(report === undefined ? {} : { report }),
      };
    };
    const { hooks, nested } = this.deps;
    let content = prompt;
    if (hooks && nested !== true) {
      const r = await hooks.run('UserPromptSubmit', { prompt }, { signal: runOpts.signal });
      this.warn(runOpts.onEvent, r.warnings);
      if (r.cancelled) return outcome('interrupted');
      if (r.blocked) return outcome('blocked', r.message ?? 'Blocked by a UserPromptSubmit hook.');
      if (r.context.length > 0)
        content = `${prompt}\n\n<hook-context>\n${r.context.join('\n')}\n</hook-context>`;
    }
    // The task runs on its own signal: the user's interrupt and the time budget both stop it.
    const budget = this.deps.budget?.() ?? {};
    const inner = new AbortController();
    const relay = (): void => {
      inner.abort();
    };
    if (runOpts.signal.aborted) inner.abort();
    else runOpts.signal.addEventListener('abort', relay, { once: true });
    const timer =
      budget.seconds === undefined
        ? undefined
        : setTimeout(() => {
            task.budgetHit = `Stopped at the time budget: this task ran for ${String(budget.seconds)}s. What VinaX did so far is kept. Send a message to continue, or raise the limit with --time-budget or "budget.seconds" in settings.`;
            inner.abort(TIME_BUDGET_ABORT);
          }, budget.seconds * 1000);
    let opts: StepOptions = { ...runOpts, signal: inner.signal, task };

    const turn = ++this.turnCounter;
    this.taskStart = this.messages.length;
    if (nested !== true) {
      const mark = { turn, messageIndex: this.messages.length, prompt };
      this.marks.push(mark);
      this.deps.recorder?.record({ type: 'turn', ...mark });
      this.deps.checkpoints.beginTurn(turn);
    }
    this.push(
      opts.images && opts.images.length > 0
        ? { role: 'user', content, images: [...opts.images] }
        : { role: 'user', content },
    );
    const visionModel = this.visionModelFor(opts);
    if (visionModel !== undefined)
      opts = { ...opts, model: visionModel.ref, fallbacks: visionModel.fallbacks };
    if (visionModel?.notice !== undefined)
      opts.onEvent({ type: 'notice', level: 'info', text: visionModel.notice });
    let stopRetries = 0;
    const overBudget = (next: number): string | undefined => {
      if (budget.tokens === undefined) return undefined;
      const used = task.total();
      if (used + next <= budget.tokens) return undefined;
      const { measured, estimated } = task.totals();
      const split = `${kTokens(totalTokens(measured))} measured, ${kTokens(totalTokens(estimated))} estimated`;
      const what =
        used >= budget.tokens
          ? `this task used ~${kTokens(used)} tokens (${split}) of its ${kTokens(budget.tokens)} budget`
          : `the next request (~${kTokens(next)} tokens) would take this task (~${kTokens(used)} so far: ${split}) past its ${kTokens(budget.tokens)} budget`;
      return `Stopped at the token budget: ${what}. What VinaX did so far is kept. Send a message to continue (each task gets a fresh budget), or raise it with --token-budget or "budget.tokens" in settings.`;
    };

    const removeRules = this.deps.permissions.addTemporaryRules(opts.allowRules ?? []);
    try {
      for (;;) {
        if (this.deps.maxTurns !== undefined && steps >= this.deps.maxTurns) {
          return outcome('max_turns', `Stopped after ${String(steps)} model calls (--max-turns).`);
        }
        if (this.deps.contextLimit) {
          try {
            await this.compact({
              mode: opts.host.mode(),
              signal: opts.signal,
              inTurn: true,
              onEvent: opts.onEvent,
            });
          } catch (err) {
            if (opts.signal.aborted)
              return task.budgetHit === undefined
                ? outcome('interrupted')
                : outcome('budget', task.budgetHit);
            opts.onEvent({
              type: 'notice',
              level: 'warning',
              text: `Could not compact the conversation: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
        }
        const tooMuch = overBudget(this.requestTokens(opts.host.mode()));
        if (tooMuch !== undefined) return outcome('budget', tooMuch);
        steps++;
        const step = await this.step(turn, steps, opts, models);
        lastText = step.text;
        if (task.budgetHit !== undefined) return outcome('budget', task.budgetHit);
        if (step.status === 'stuck') return outcome('stuck', step.error);
        if (
          step.status === 'done' &&
          hooks?.has('Stop') === true &&
          nested !== true &&
          stopRetries < MAX_STOP_HOOK_RETRIES
        ) {
          const r = await hooks.run(
            'Stop',
            { stop_hook_active: stopRetries > 0, last_assistant_message: step.text },
            { signal: opts.signal },
          );
          this.warn(opts.onEvent, r.warnings);
          if (r.blocked) {
            stopRetries++;
            opts.onEvent({
              type: 'notice',
              level: 'info',
              text: `A Stop hook asked VinaX to keep going: ${r.message ?? ''}`,
            });
            this.push({
              role: 'user',
              content: `A Stop hook did not accept finishing yet:\n${r.message ?? ''}\nAddress this, then finish.`,
            });
            continue;
          }
        }
        if (step.status !== 'continue') return outcome(step.status, step.error, step.report);
        const used = overBudget(0);
        if (used !== undefined) return outcome('budget', used);
      }
    } finally {
      removeRules();
      if (timer !== undefined) clearTimeout(timer);
      runOpts.signal.removeEventListener('abort', relay);
    }
  }

  /** The conversation as `ref` can take it: images become a short note for text-only models. */
  private forModel(ref: ModelRef): ChatMessage[] {
    const sees = this.deps.supportsVision?.(ref) ?? false;
    if (sees) return this.messages;
    return this.messages.map((m) => {
      if (m.role !== 'user' || m.images === undefined || m.images.length === 0) return m;
      const names = m.images.map((i, n) => i.name ?? `image ${String(n + 1)}`).join(', ');
      return {
        role: 'user',
        content: `${m.content}\n\n[${String(m.images.length)} image(s) were attached (${names}), but this model cannot see images.]`,
      };
    });
  }

  /**
   * When the prompt carries images and the model in use cannot see them, the turn goes to a
   * vision-capable model instead (and says so).
   */
  private visionModelFor(
    opts: RunOptions,
  ): { ref: string; fallbacks: string[]; notice?: string } | undefined {
    if (opts.images === undefined || opts.images.length === 0) return undefined;
    const current = opts.model ?? this.model ?? this.deps.defaultModel?.();
    if (current !== undefined && (this.deps.supportsVision?.(parseModelRef(current)) ?? false))
      return undefined;
    const [vision, ...others] = this.deps.visionModels?.() ?? [];
    if (vision === undefined) {
      opts.onEvent({
        type: 'notice',
        level: 'warning',
        text: 'No vision-capable model is available, so the model only sees the image file names. Set `visionModel` in settings, or add a key for a provider with vision models.',
      });
      return undefined;
    }
    return {
      ref: vision,
      fallbacks: others,
      notice: `Using ${vision} to look at the image${opts.images.length === 1 ? '' : 's'}${current === undefined ? '' : ` (${current} cannot see images)`}.`,
    };
  }

  private async step(
    turn: number,
    stepNo: number,
    opts: StepOptions,
    models: Set<string>,
  ): Promise<{
    status: 'continue' | AgentOutcome['status'];
    text: string;
    error?: string;
    report?: FailureReport;
  }> {
    const { signal, host, onEvent, task } = opts;
    const mode = host.mode();
    const active = this.deps.tools.filter((t) =>
      mode === 'plan' ? t.readOnly : t.name !== 'ExitPlanMode',
    );
    const specs = active.map(toolSpec);

    let text = '';
    let current: ToolMode = 'native';
    let parser = new TextCallParser();
    const textCalls: { name: string; arguments: string }[] = [];
    const native = new Map<number, { id: string; name: string; args: string }>();
    // for estimating usage when a provider does not report it
    let attempt: string | undefined;
    let promptEstimate = 0;
    let outputChars = 0;
    const estimateAttempt = (): void => {
      if (attempt === undefined || outputChars === 0) return;
      task.estimated(attempt, {
        promptTokens: promptEstimate,
        completionTokens: Math.ceil(outputChars / 4),
      });
      outputChars = 0;
    };

    const prepare = (ref: ModelRef) => {
      const history = this.forModel(ref);
      const req =
        this.modeFor(ref) === 'native'
          ? {
              messages: [
                { role: 'system' as const, content: this.deps.systemPrompt(mode) },
                ...history,
              ],
              tools: specs,
            }
          : {
              messages: [
                {
                  role: 'system' as const,
                  content: this.deps.systemPrompt(mode, textProtocolInstructions(specs)),
                },
                ...toTextProtocol(history),
              ],
            };
      promptEstimate = estimateTokens(req.messages, req.tools);
      return req;
    };

    try {
      const events = this.deps.router.stream({
        messages: this.messages,
        signal,
        ...(this.effort === undefined ? {} : { reasoningEffort: this.effort }),
        prepare,
        onToolFormatError: (ref) =>
          this.useTextProtocol(ref, onEvent, 'sent a tool call the provider rejected'),
        ...((opts.model ?? this.model) === undefined ? {} : { model: opts.model ?? this.model }),
        ...(opts.fallbacks === undefined ? {} : { fallbacks: opts.fallbacks }),
      });
      for await (const ev of events) {
        switch (ev.type) {
          case 'attempt':
            current = this.modeFor(ev.ref);
            text = '';
            parser = new TextCallParser();
            textCalls.length = 0;
            native.clear();
            attempt = formatModelRef(ev.ref);
            outputChars = 0;
            models.add(attempt);
            onEvent(ev);
            this.noteCapabilities(ev.ref, promptEstimate, onEvent);
            break;
          case 'reasoning':
            outputChars += ev.text.length;
            onEvent(ev);
            break;
          case 'text':
            outputChars += ev.text.length;
            if (current === 'text') {
              const r = parser.push(ev.text);
              textCalls.push(...r.calls);
              if (r.text !== '') {
                text += r.text;
                onEvent({ type: 'text', text: r.text });
              }
            } else {
              text += ev.text;
              onEvent(ev);
            }
            break;
          case 'tool_call_delta': {
            outputChars += (ev.name?.length ?? 0) + (ev.argsChunk?.length ?? 0);
            const slot = native.get(ev.index) ?? { id: '', name: '', args: '' };
            if (ev.id !== undefined) slot.id = ev.id;
            if (ev.name !== undefined) slot.name += ev.name;
            if (ev.argsChunk !== undefined) slot.args += ev.argsChunk;
            native.set(ev.index, slot);
            break;
          }
          case 'done':
            if (ev.usage) {
              task.measured(formatModelRef(ev.ref), ev.usage);
              outputChars = 0;
            } else estimateAttempt();
            onEvent(ev);
            break;
          default:
            onEvent(ev);
        }
      }
    } catch (err) {
      // a reply cut off mid-stream still cost tokens
      estimateAttempt();
      if (err instanceof AbortError) {
        const marker =
          task.budgetHit === undefined
            ? INTERRUPTED_MARKER
            : '[stopped: the task reached its time budget]';
        this.push({
          role: 'assistant',
          content: text === '' ? marker : `${text}\n\n${marker}`,
        });
        return { status: 'interrupted', text };
      }
      if (text !== '') this.push({ role: 'assistant', content: text });
      // an unanswered prompt is dropped entirely so the user can simply ask again
      else if (stepNo === 1) this.truncate(this.messages.length - 1, this.marks.length - 1);
      else this.push({ role: 'assistant', content: '[the model could not be reached]' });
      return {
        status: 'failed',
        text,
        error: err instanceof Error ? err.message : String(err),
        report: explainError(err),
      };
    }

    if (current === 'text') {
      const rest = parser.flush();
      textCalls.push(...rest.calls);
      if (rest.text !== '') {
        text += rest.text;
        onEvent({ type: 'text', text: rest.text });
      }
      text = tidyVisibleText(text);
    }
    const calls: ToolCall[] =
      current === 'text'
        ? textCalls.map((c, i) => ({
            id: `vx_${String(turn)}_${String(stepNo)}_${String(i)}`,
            name: c.name,
            arguments: c.arguments,
          }))
        : [...native.entries()]
            .sort(([a], [b]) => a - b)
            .map(([i, c]) => ({
              id: c.id === '' ? `call_${String(turn)}_${String(stepNo)}_${String(i)}` : c.id,
              name: c.name,
              arguments: c.args,
            }));

    this.push({
      role: 'assistant',
      content: text,
      ...(calls.length === 0 ? {} : { toolCalls: calls }),
    });
    if (calls.length === 0) return { status: 'done', text };

    const result = await this.runCalls(calls, current, [...models].at(-1), opts);
    const spinning = task.guard.endStep();
    task.stuck ??= spinning;
    if (result.interrupted) return { status: 'interrupted', text };
    if (task.stuck !== undefined)
      return { status: 'stuck', text, error: `Stopped: ${task.stuck} ${STUCK_ADVICE}` };
    if (result.declined !== undefined) {
      if (result.declined === '') return { status: 'declined', text };
      this.push({
        role: 'user',
        content: `I declined that action. Instead: ${result.declined}`,
      });
    }
    return { status: 'continue', text };
  }

  private readonly noted = new Set<string>();

  /** Says once per model when what it can do limits this session (tools, context size). */
  private noteCapabilities(ref: ModelRef, requestTokens: number, onEvent: RunOptions['onEvent']) {
    const key = formatModelRef(ref);
    if (
      this.deps.supportsTools?.(ref) === false &&
      this.toolModes.get(key) === undefined &&
      !this.noted.has(`${key}:tools`)
    ) {
      this.noted.add(`${key}:tools`);
      onEvent({
        type: 'notice',
        level: 'info',
        text: `${key} has no native tool calling, so VinaX drives its tools through a text protocol (it works, but expect more formatting slips).`,
      });
    }
    const window = this.deps.contextWindow?.(ref);
    if (window !== undefined && requestTokens > window && !this.noted.has(`${key}:ctx`)) {
      this.noted.add(`${key}:ctx`);
      onEvent({
        type: 'notice',
        level: 'warning',
        text: `${key} accepts about ${kTokens(window)} tokens, but this request is ~${kTokens(requestTokens)}, so it may be rejected. Run /compact, or choose a model with a larger context with /model.`,
      });
    }
  }

  private prepareCall(
    call: ToolCall,
    mode: ToolMode,
    modelKey: string | undefined,
    onEvent: RunOptions['onEvent'],
  ): Prepared {
    const tool = this.deps.tools.find((t) => t.name === call.name);
    if (!tool) {
      const names = this.deps.tools.map((t) => t.name).join(', ');
      return {
        call,
        tool,
        input: undefined,
        error: `Unknown tool "${call.name}". Available tools: ${names}.`,
      };
    }
    let raw: unknown;
    try {
      raw = call.arguments.trim() === '' ? {} : JSON.parse(call.arguments);
    } catch (err) {
      if (mode === 'native' && modelKey !== undefined) {
        const n = (this.malformed.get(modelKey) ?? 0) + 1;
        this.malformed.set(modelKey, n);
        if (n >= MALFORMED_LIMIT) {
          this.toolModes.set(modelKey, 'text');
          onEvent({
            type: 'notice',
            level: 'info',
            text: `${modelKey} keeps sending malformed tool calls; switching it to VinaX's text tool protocol.`,
          });
        }
      }
      return {
        call,
        tool,
        input: undefined,
        error: `The arguments for ${call.name} were not valid JSON (${(err as Error).message}). Send one JSON object.`,
      };
    }
    const parsed = tool.input.safeParse(raw);
    if (!parsed.success)
      return { call, tool, input: undefined, error: describeInvalidArgs(tool.name, parsed.error) };
    return { call, tool, input: parsed.data, error: undefined };
  }

  private async runCalls(
    calls: readonly ToolCall[],
    mode: ToolMode,
    modelKey: string | undefined,
    { signal, host, onEvent, task }: StepOptions,
  ): Promise<{ interrupted: boolean; declined?: string }> {
    const results = new Map<string, string>();
    const byId = new Map(calls.map((c) => [c.id, c]));
    const labels = new Map<string, string>();
    /** `counts`: the call really ran (or was malformed), so it counts towards loop detection. */
    const finish = (id: string, name: string, out: ToolOutput, counts = true): void => {
      let content = out.content;
      const call = byId.get(id);
      if (counts && call !== undefined) {
        const verdict = task.guard.record(
          name,
          call.arguments,
          out.ok,
          out.content,
          labels.get(id) ?? '',
        );
        if (verdict.nudge !== undefined) content = `${content}\n\n${verdict.nudge}`;
        task.stuck ??= verdict.stop;
      }
      results.set(id, content);
      onEvent({
        type: 'tool_result',
        id,
        name,
        ok: out.ok,
        summary: out.summary,
        content: out.content,
        ...(out.display === undefined ? {} : { display: out.display }),
      });
    };
    const fail = (message: string, summary = message): ToolOutput => ({
      ok: false,
      content: message,
      summary,
    });

    const prepared = calls.map((c) => this.prepareCall(c, mode, modelKey, onEvent));
    let declined: string | undefined;
    let interrupted = false;

    // Consecutive read-only calls form a batch that runs in parallel; anything else runs alone.
    const batches: Prepared[][] = [];
    for (const p of prepared) {
      const last = batches.at(-1);
      if (
        p.tool?.readOnly === true &&
        p.tool.kind !== 'meta' &&
        last?.every((q) => q.tool?.readOnly === true && q.tool.kind !== 'meta')
      )
        last.push(p);
      else batches.push([p]);
    }

    for (const batch of batches) {
      const runnable: Prepared[] = [];
      for (const p of batch) {
        const label = p.tool && p.input !== undefined ? p.tool.label(p.input) : p.call.name;
        labels.set(p.call.id, label);
        onEvent({
          type: 'tool_call',
          id: p.call.id,
          name: p.call.name,
          label,
          input: p.input ?? p.call.arguments,
        });
        if (interrupted || signal.aborted) {
          interrupted = true;
          finish(p.call.id, p.call.name, fail(`Not run: ${task.why()}.`, 'Interrupted'), false);
          continue;
        }
        if (declined !== undefined) {
          finish(
            p.call.id,
            p.call.name,
            fail('Not run: the user declined an earlier action in this reply.', 'Skipped'),
            false,
          );
          continue;
        }
        if (task.stuck !== undefined) {
          finish(
            p.call.id,
            p.call.name,
            fail('Not run: VinaX stopped this task because it was going in circles.', 'Skipped'),
            false,
          );
          continue;
        }
        if (p.error !== undefined || !p.tool) {
          finish(
            p.call.id,
            p.call.name,
            fail(p.error ?? 'Unknown tool', p.error?.split('\n')[0] ?? 'Error'),
          );
          continue;
        }
        const tool = p.tool;
        const ctx: ToolContext = {
          ...this.deps.context,
          signal,
          host,
          ...(host.approvePlan ? { approvePlan: host.approvePlan } : {}),
        };
        let hookApproved = false;
        if (this.deps.hooks?.has('PreToolUse', tool.name) === true) {
          const r = await this.deps.hooks.run(
            'PreToolUse',
            { tool_name: tool.name, tool_input: p.input },
            { toolName: tool.name, signal },
          );
          this.warn(onEvent, r.warnings);
          if (r.blocked) {
            finish(
              p.call.id,
              tool.name,
              fail(`Blocked by a PreToolUse hook: ${r.message ?? ''}`, 'Blocked by a hook'),
            );
            continue;
          }
          hookApproved = r.approved;
        }
        const target = tool.target(p.input, ctx);
        const decided = this.deps.permissions.decide(
          { name: tool.name, kind: tool.kind, readOnly: tool.readOnly, target },
          host.mode(),
        );
        // a hook can pre-approve an ordinary prompt, never a dangerous action or a deny rule
        const decision =
          decided.kind === 'ask' && hookApproved && decided.danger === undefined
            ? ({ kind: 'allow', reason: 'Approved by a PreToolUse hook' } as const)
            : decided;
        if (decision.kind === 'deny') {
          finish(p.call.id, tool.name, fail(`Permission denied: ${decision.reason}`, 'Denied'));
          continue;
        }
        if (decision.kind === 'ask') {
          const preview = await tool.preview?.(p.input, ctx).catch(() => undefined);
          let answer: PermissionAnswer;
          try {
            answer = await host.askPermission(
              {
                callId: p.call.id,
                tool: tool.name,
                kind: tool.kind,
                label,
                input: p.input,
                reason: decision.reason,
                ...(decision.danger === undefined ? {} : { danger: decision.danger }),
                ...(decision.suggestion === undefined ? {} : { suggestion: decision.suggestion }),
                ...(preview === undefined ? {} : { preview }),
              },
              signal,
            );
          } catch {
            answer = { kind: 'deny', feedback: '' };
          }
          if (isAborted(signal)) {
            interrupted = true;
            finish(p.call.id, tool.name, fail(`Not run: ${task.why()}.`, 'Interrupted'), false);
            continue;
          }
          if (answer.kind === 'unavailable') {
            finish(p.call.id, tool.name, fail(answer.message, 'Needs approval'));
            continue;
          }
          if (answer.kind === 'deny') {
            declined = answer.feedback.trim();
            finish(p.call.id, tool.name, fail('The user declined this action.', 'Declined'), false);
            continue;
          }
          if (answer.kind === 'allow_rule') {
            this.deps.permissions.addSessionRule(answer.rule);
            if (answer.scope === 'project') await host.saveProjectRule?.(answer.rule);
          }
        }
        runnable.push(p);
      }

      const execute = async (p: Prepared): Promise<void> => {
        const tool = p.tool;
        if (!tool) return;
        const ctx: ToolContext = {
          ...this.deps.context,
          signal,
          host,
          ...(host.approvePlan ? { approvePlan: host.approvePlan } : {}),
          onProgress: (chunk) => {
            onEvent({ type: 'tool_progress', id: p.call.id, chunk });
          },
          // a sub-agent's tokens count towards this task (and its budget)
          addUsage: (byModel) => {
            for (const [ref, u] of Object.entries(byModel)) {
              task.measured(ref, u.measured);
              task.estimated(ref, u.estimated);
            }
          },
        };
        const affected = tool.affectedPaths?.(p.input, ctx) ?? [];
        try {
          await this.deps.checkpoints.capture(affected);
          // Input can change the mode or cancel the turn while approval/checkpointing waits.
          if (signal.aborted) {
            finish(p.call.id, tool.name, fail(`Not run: ${task.why()}.`, 'Interrupted'), false);
            return;
          }
          if (host.mode() === 'plan' && !tool.readOnly && tool.kind !== 'meta') {
            finish(p.call.id, tool.name, fail('Not run: plan mode is now on.', 'Denied'));
            return;
          }
          const output = await tool.run(p.input, ctx).finally(async () => {
            // what the file holds now, even after a failed edit, so rewind can spot outside edits
            if (affected.length > 0) await this.deps.checkpoints.recordResult(affected);
          });
          const touched = tool.target(p.input, ctx).path;
          const extra: string[] = [];
          const found = touched === undefined ? undefined : this.deps.onPathTouched?.(touched);
          if (found !== undefined) extra.push(found);
          if (this.deps.hooks?.has('PostToolUse', tool.name) === true) {
            const r = await this.deps.hooks.run(
              'PostToolUse',
              {
                tool_name: tool.name,
                tool_input: p.input,
                tool_response: {
                  ok: output.ok,
                  summary: output.summary,
                  content: output.content.slice(0, 4000),
                },
              },
              { toolName: tool.name, signal },
            );
            this.warn(onEvent, r.warnings);
            if (r.blocked) extra.push(`[PostToolUse hook feedback]\n${r.message ?? ''}`);
            for (const c of r.context) extra.push(`[PostToolUse hook]\n${c}`);
          }
          finish(
            p.call.id,
            tool.name,
            extra.length === 0
              ? output
              : { ...output, content: `${output.content}\n\n${extra.join('\n\n')}` },
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          finish(p.call.id, tool.name, fail(message, message.split('\n')[0] ?? message));
        }
      };
      if (runnable.length > 1) await Promise.all(runnable.map(execute));
      else for (const p of runnable) await execute(p);
      if (signal.aborted) interrupted = true;
    }

    for (const c of calls) {
      this.push({
        role: 'tool',
        toolCallId: c.id,
        name: c.name,
        content: results.get(c.id) ?? 'Not run.',
      });
    }
    return { interrupted, ...(declined === undefined ? {} : { declined }) };
  }
}
