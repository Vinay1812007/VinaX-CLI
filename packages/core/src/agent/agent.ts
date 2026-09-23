import type { PermissionMode } from '../config/schema.js';
import type { PermissionEngine } from '../permissions/engine.js';
import {
  formatModelRef,
  type ChatMessage,
  type ModelRef,
  type ToolCall,
  type Usage,
} from '../providers/types.js';
import { AbortError } from '../router/backoff.js';
import type { Router, RouterEvent } from '../router/router.js';
import type { PlanDecision } from '../tools/plan-tool.js';
import { describeInvalidArgs, toolSpec } from '../tools/registry.js';
import type { AnyTool, ToolContext, ToolDisplay, ToolKind, ToolOutput } from '../tools/types.js';
import type { CheckpointStore } from './checkpoints.js';
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
  approvePlan?: (plan: string) => Promise<PlanDecision>;
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
  | { type: 'notice'; level: 'info' | 'warning'; text: string };

export interface AgentOutcome {
  status: 'done' | 'interrupted' | 'failed' | 'max_turns' | 'declined';
  /** The final assistant text of the turn. */
  text: string;
  error?: string;
  steps: number;
  usage: Usage;
  models: string[];
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
  /** Model calls allowed per user turn. */
  maxTurns?: number;
  /** Head of the fallback chain (e.g. `--model`). */
  model?: string;
}

interface Prepared {
  call: ToolCall;
  tool: AnyTool | undefined;
  input: unknown;
  error: string | undefined;
}

interface TurnMark {
  turn: number;
  messageIndex: number;
  prompt: string;
}

/** Everything the loop needs to run one user turn. */
interface RunOptions {
  signal: AbortSignal;
  host: AgentHost;
  onEvent: (ev: AgentEvent) => void;
}

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

  constructor(private readonly deps: AgentDeps) {}

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

  /** Drops the conversation from `turn` on and returns that turn's prompt. */
  rewindConversation(turn: number): string | undefined {
    const idx = this.marks.findIndex((m) => m.turn === turn);
    const mark = this.marks[idx];
    if (!mark) return undefined;
    this.messages.length = mark.messageIndex;
    this.marks.length = idx;
    return mark.prompt;
  }

  async run(prompt: string, opts: RunOptions): Promise<AgentOutcome> {
    const turn = ++this.turnCounter;
    this.marks.push({ turn, messageIndex: this.messages.length, prompt });
    this.deps.checkpoints.beginTurn(turn);
    this.messages.push({ role: 'user', content: prompt });
    const usage: Usage = { promptTokens: 0, completionTokens: 0 };
    const models = new Set<string>();
    let steps = 0;
    let lastText = '';
    const outcome = (status: AgentOutcome['status'], error?: string): AgentOutcome => ({
      status,
      text: lastText,
      steps,
      usage,
      models: [...models],
      ...(error === undefined ? {} : { error }),
    });

    for (;;) {
      if (this.deps.maxTurns !== undefined && steps >= this.deps.maxTurns) {
        return outcome('max_turns', `Stopped after ${String(steps)} model calls (--max-turns).`);
      }
      steps++;
      const step = await this.step(turn, steps, opts, usage, models);
      lastText = step.text;
      if (step.status !== 'continue') return outcome(step.status, step.error);
    }
  }

  private async step(
    turn: number,
    stepNo: number,
    opts: RunOptions,
    usage: Usage,
    models: Set<string>,
  ): Promise<{ status: 'continue' | AgentOutcome['status']; text: string; error?: string }> {
    const { signal, host, onEvent } = opts;
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

    const prepare = (ref: ModelRef) =>
      this.modeFor(ref) === 'native'
        ? {
            messages: [
              { role: 'system' as const, content: this.deps.systemPrompt(mode) },
              ...this.messages,
            ],
            tools: specs,
          }
        : {
            messages: [
              {
                role: 'system' as const,
                content: this.deps.systemPrompt(mode, textProtocolInstructions(specs)),
              },
              ...toTextProtocol(this.messages),
            ],
          };

    try {
      const events = this.deps.router.stream({
        messages: this.messages,
        signal,
        prepare,
        onToolFormatError: (ref) =>
          this.useTextProtocol(ref, onEvent, 'sent a tool call the provider rejected'),
        ...(this.deps.model === undefined ? {} : { model: this.deps.model }),
      });
      for await (const ev of events) {
        switch (ev.type) {
          case 'attempt':
            current = this.modeFor(ev.ref);
            text = '';
            parser = new TextCallParser();
            textCalls.length = 0;
            native.clear();
            models.add(formatModelRef(ev.ref));
            onEvent(ev);
            break;
          case 'text':
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
            const slot = native.get(ev.index) ?? { id: '', name: '', args: '' };
            if (ev.id !== undefined) slot.id = ev.id;
            if (ev.name !== undefined) slot.name += ev.name;
            if (ev.argsChunk !== undefined) slot.args += ev.argsChunk;
            native.set(ev.index, slot);
            break;
          }
          case 'done':
            usage.promptTokens += ev.usage?.promptTokens ?? 0;
            usage.completionTokens += ev.usage?.completionTokens ?? 0;
            onEvent(ev);
            break;
          default:
            onEvent(ev);
        }
      }
    } catch (err) {
      if (err instanceof AbortError) {
        this.messages.push({
          role: 'assistant',
          content: text === '' ? INTERRUPTED_MARKER : `${text}\n\n${INTERRUPTED_MARKER}`,
        });
        return { status: 'interrupted', text };
      }
      if (text !== '') this.messages.push({ role: 'assistant', content: text });
      else if (stepNo === 1)
        this.messages.pop(); // unanswered prompt: let the user simply ask again
      else this.messages.push({ role: 'assistant', content: '[the model could not be reached]' });
      return { status: 'failed', text, error: err instanceof Error ? err.message : String(err) };
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

    this.messages.push({
      role: 'assistant',
      content: text,
      ...(calls.length === 0 ? {} : { toolCalls: calls }),
    });
    if (calls.length === 0) return { status: 'done', text };

    const result = await this.runCalls(calls, current, [...models].at(-1), opts);
    if (result.interrupted) return { status: 'interrupted', text };
    if (result.declined !== undefined) {
      if (result.declined === '') return { status: 'declined', text };
      this.messages.push({
        role: 'user',
        content: `I declined that action. Instead: ${result.declined}`,
      });
    }
    return { status: 'continue', text };
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
    { signal, host, onEvent }: RunOptions,
  ): Promise<{ interrupted: boolean; declined?: string }> {
    const results = new Map<string, string>();
    const finish = (id: string, name: string, out: ToolOutput): void => {
      results.set(id, out.content);
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
      if (p.tool?.readOnly === true && last?.every((q) => q.tool?.readOnly === true)) last.push(p);
      else batches.push([p]);
    }

    for (const batch of batches) {
      const runnable: Prepared[] = [];
      for (const p of batch) {
        const label = p.tool && p.input !== undefined ? p.tool.label(p.input) : p.call.name;
        onEvent({
          type: 'tool_call',
          id: p.call.id,
          name: p.call.name,
          label,
          input: p.input ?? p.call.arguments,
        });
        if (interrupted || signal.aborted) {
          interrupted = true;
          finish(p.call.id, p.call.name, fail('Not run: the user interrupted.', 'Interrupted'));
          continue;
        }
        if (declined !== undefined) {
          finish(
            p.call.id,
            p.call.name,
            fail('Not run: the user declined an earlier action in this reply.', 'Skipped'),
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
          ...(host.approvePlan ? { approvePlan: host.approvePlan } : {}),
        };
        const target = tool.target(p.input, ctx);
        const decision = this.deps.permissions.decide(
          { name: tool.name, kind: tool.kind, readOnly: tool.readOnly, target },
          host.mode(),
        );
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
            finish(p.call.id, tool.name, fail('Not run: the user interrupted.', 'Interrupted'));
            continue;
          }
          if (answer.kind === 'unavailable') {
            finish(p.call.id, tool.name, fail(answer.message, 'Needs approval'));
            continue;
          }
          if (answer.kind === 'deny') {
            declined = answer.feedback.trim();
            finish(p.call.id, tool.name, fail('The user declined this action.', 'Declined'));
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
          ...(host.approvePlan ? { approvePlan: host.approvePlan } : {}),
          onProgress: (chunk) => {
            onEvent({ type: 'tool_progress', id: p.call.id, chunk });
          },
        };
        try {
          await this.deps.checkpoints.capture(tool.affectedPaths?.(p.input, ctx) ?? []);
          finish(p.call.id, tool.name, await tool.run(p.input, ctx));
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
      this.messages.push({
        role: 'tool',
        toolCallId: c.id,
        name: c.name,
        content: results.get(c.id) ?? 'Not run.',
      });
    }
    return { interrupted, ...(declined === undefined ? {} : { declined }) };
  }
}
