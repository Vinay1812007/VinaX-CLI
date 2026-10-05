import { formatModelRef, providerLabel, type AgentEvent, type AgentOutcome } from '@vinax/core';
import type { StatusNotice } from './components/StatusLine.js';
import { formatTokens } from './format.js';
import { extendTrail, phaseFor, type Phase } from './phases.js';
import { splitStable, type NewTranscriptItem, type ToolRecord } from './transcript.js';

const RUNNING_OUTPUT_CHARS = 4000;

/** The live part of a turn below the permanent transcript. */
export interface Streaming {
  startedAt: number;
  tail: string;
  chars: number;
  committed: boolean;
  waiting: string | undefined;
  /** Replaces the rotating verb, e.g. "Compacting the conversation". */
  label?: string;
  /** Stages of this turn so far (Inspecting repository → Editing → Running tests). */
  trail?: Phase[];
  /** The model's reasoning while it thinks (cleared once the answer or a tool call starts). */
  thinking?: string;
  /** Tokens providers reported so far in this turn. */
  tokens?: number;
}

/** A tool call that has not finished yet. */
export interface Running {
  id: string;
  name: string;
  label: string;
  output: string;
}

/** Where a turn's events go: the screen's state setters and the session's records. */
export interface TurnSink {
  push: (item: NewTranscriptItem) => number;
  setStreaming: (update: (s: Streaming | undefined) => Streaming | undefined) => void;
  setRunning: (update: (r: Running[]) => Running[]) => void;
  setNotice: (notice: StatusNotice | undefined) => void;
  setActiveModel: (model: string) => void;
  /** Full tool output by transcript item id (for the transcript browser). */
  toolOutputs: Map<number, string>;
  /** Files edited and lines changed this session (for the exit summary). */
  changes: { files: Set<string>; added: number; removed: number };
  /** Streamed answer text not yet printed permanently, and whether this answer began. */
  stream: { tail: string; committed: boolean };
  now: () => number;
}

/**
 * Turns agent events into transcript items and live state for one turn. Completed Markdown
 * blocks are printed permanently as they arrive; only the unfinished tail re-renders.
 */
export function createTurnTracker(sink: TurnSink): {
  onEvent: (ev: AgentEvent) => void;
  /** Prints whatever answer text is still pending. */
  commitTail: () => void;
  /** Ends a thinking phase ("✻ Thought for 4s"). */
  endThinking: () => void;
  readonly model: string | undefined;
  readonly fallbacks: string[];
  readonly tools: ToolRecord[];
} {
  const { push, setStreaming, setRunning, now, stream } = sink;
  const fallbacks: string[] = [];
  const tools: ToolRecord[] = [];
  const labels = new Map<string, string>();
  const toolStarts = new Map<string, number>();
  let model: string | undefined;
  let thinkingSince: number | undefined;

  const endThinking = (): void => {
    if (thinkingSince === undefined) return;
    push({ kind: 'thought', durationMs: now() - thinkingSince });
    thinkingSince = undefined;
    setStreaming((st) => st && { ...st, thinking: undefined });
  };
  const commitTail = (): void => {
    const rest = stream.tail.trim();
    if (rest !== '') {
      push({ kind: 'assistant', markdown: rest, first: !stream.committed });
      stream.committed = true;
    }
    stream.tail = '';
    setStreaming((s) => s && { ...s, tail: '' });
  };

  const onEvent = (ev: AgentEvent): void => {
    if (ev.type !== 'reasoning' && ev.type !== 'status' && ev.type !== 'wait') endThinking();
    switch (ev.type) {
      case 'reasoning': {
        thinkingSince ??= now();
        const add = ev.text;
        setStreaming((st) => st && { ...st, thinking: `${st.thinking ?? ''}${add}`.slice(-600) });
        return;
      }
      case 'text': {
        stream.tail += ev.text;
        const { stable, rest } = splitStable(stream.tail);
        if (stable !== '') {
          push({ kind: 'assistant', markdown: stable, first: !stream.committed });
          stream.committed = true;
          stream.tail = rest;
        }
        const tail = stream.tail;
        const committed = stream.committed;
        setStreaming(
          (s) =>
            s && { ...s, tail, committed, chars: s.chars + ev.text.length, waiting: undefined },
        );
        return;
      }
      case 'tool_call': {
        commitTail();
        stream.committed = false;
        labels.set(ev.id, ev.label);
        toolStarts.set(ev.id, now());
        const phase = phaseFor(ev.name, ev.label);
        setStreaming((s) => s && { ...s, trail: extendTrail(s.trail ?? [], phase) });
        setRunning((r) => [...r, { id: ev.id, name: ev.name, label: ev.label, output: '' }]);
        return;
      }
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
        const began = toolStarts.get(ev.id);
        setRunning((r) => r.filter((t) => t.id !== ev.id));
        const itemId = push({
          kind: 'tool',
          name: ev.name,
          label,
          ok: ev.ok,
          summary: ev.summary,
          display: ev.display,
          ...(began === undefined ? {} : { durationMs: now() - began }),
        });
        sink.toolOutputs.set(itemId, ev.content);
        tools.push({ name: ev.name, label, ok: ev.ok, summary: ev.summary, output: ev.content });
        if (ev.ok && ev.display?.kind === 'diff') {
          sink.changes.files.add(ev.display.path);
          sink.changes.added += ev.display.added;
          sink.changes.removed += ev.display.removed;
        }
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
        sink.setActiveModel(model);
        return;
      case 'wait': {
        const waiting = `Waiting ${String(Math.ceil(ev.ms / 1000))}s: ${providerLabel(ev.ref.provider)} ${ev.reason}`;
        setStreaming((s) => s && { ...s, waiting });
        return;
      }
      case 'status': {
        const waiting = ev.text === '' ? undefined : ev.text;
        setStreaming((s) => s && { ...s, waiting });
        return;
      }
      case 'retry':
        sink.setNotice({
          level: 'warning',
          text: `↻ ${ev.reason} — retrying in ${(ev.delayMs / 1000).toFixed(1)}s`,
        });
        return;
      case 'fallback': {
        const to = formatModelRef(ev.to);
        fallbacks.push(`${to} (${ev.reason})`);
        const text = `${ev.reason} — switched to ${to}`;
        push({ kind: 'notice', level: 'info', text });
        sink.setNotice({ level: 'warning', text: `↪ ${text}` });
        return;
      }
      case 'done': {
        const used = ev.usage === undefined ? 0 : ev.usage.promptTokens + ev.usage.completionTokens;
        if (used > 0) setStreaming((st) => st && { ...st, tokens: (st.tokens ?? 0) + used });
        return;
      }
    }
  };

  return {
    onEvent,
    commitTail,
    endThinking,
    get model() {
      return model;
    },
    fallbacks,
    tools,
  };
}

/** What to tell the user about how a turn ended (nothing for an ordinary answer). */
export function outcomeItem(outcome: AgentOutcome): NewTranscriptItem | undefined {
  switch (outcome.status) {
    case 'done':
      return outcome.steps === 1 && outcome.text.trim() === ''
        ? { kind: 'notice', level: 'info', text: 'The model returned an empty answer.' }
        : undefined;
    case 'interrupted':
      return {
        kind: 'notice',
        level: 'warning',
        text: 'Interrupted — what VinaX did so far is kept. Send a message to continue, Ctrl+G to review changed files, or Esc Esc to rewind.',
      };
    case 'blocked':
      return {
        kind: 'notice',
        level: 'warning',
        text: `Not sent — a UserPromptSubmit hook blocked it: ${outcome.error ?? ''}`,
      };
    case 'declined':
      return {
        kind: 'notice',
        level: 'info',
        text: 'Stopped: you declined the action. Tell VinaX what to do instead.',
      };
    case 'budget':
    case 'stuck':
      return { kind: 'notice', level: 'warning', text: outcome.error ?? 'Stopped.' };
    case 'failed':
      return outcome.report !== undefined
        ? { kind: 'error', report: outcome.report }
        : { kind: 'notice', level: 'error', text: outcome.error ?? 'The request failed.' };
    case 'max_turns':
      return { kind: 'notice', level: 'warning', text: outcome.error ?? 'The request failed.' };
  }
}
