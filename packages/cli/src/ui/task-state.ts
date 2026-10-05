import type { AgentOutcome } from '@vinax/core';
import { formatClock, formatTokens } from './format.js';

/**
 * What the session is doing right now, for the status line. Each state reads differently so the
 * user can tell at a glance whether VinaX is working, needs them, or stopped (and why).
 */
export type TaskState =
  | { kind: 'idle' }
  /** A turn, command or `!` shell command is running; `tokens` shows use against a budget. */
  | { kind: 'running'; since: number; tokens?: { used: number; budget: number } }
  /** VinaX is blocked on the user: an approval, a plan or a question (`more` wait behind it). */
  | { kind: 'waiting'; since: number; what: 'approval' | 'plan' | 'question'; more: number }
  /** The last turn ended; kept until the next one starts. */
  | { kind: 'ended'; status: AgentOutcome['status']; durationMs: number };

export interface TaskChip {
  /** Full text, e.g. "◆ needs your approval · 0:12". */
  text: string;
  /** For narrow terminals, e.g. "◆ 0:12". */
  short: string;
  tone: 'accent' | 'warning' | 'error' | 'muted' | 'success';
}

const WAITING: Record<Extract<TaskState, { kind: 'waiting' }>['what'], string> = {
  approval: 'needs your approval',
  plan: 'plan needs your review',
  question: 'has a question for you',
};

const ENDED: Record<
  AgentOutcome['status'],
  { glyph: string; text: string; tone: TaskChip['tone'] }
> = {
  done: { glyph: '✓', text: 'done', tone: 'success' },
  interrupted: { glyph: '⏹', text: 'interrupted', tone: 'warning' },
  failed: { glyph: '✖', text: 'failed', tone: 'error' },
  max_turns: { glyph: '⏹', text: 'stopped at --max-turns', tone: 'warning' },
  declined: { glyph: '⊘', text: 'stopped: you declined', tone: 'muted' },
  blocked: { glyph: '⊘', text: 'blocked by a hook', tone: 'warning' },
  budget: { glyph: '⏹', text: 'stopped at the budget', tone: 'warning' },
  stuck: { glyph: '⟲', text: 'stopped: going in circles', tone: 'warning' },
};

/** The status-line chip for `state`, plus the queued-message count; `undefined` when idle. */
export function taskChip(state: TaskState, queued: number, now: number): TaskChip | undefined {
  const q = queued === 0 ? '' : ` · ${String(queued)} queued`;
  switch (state.kind) {
    case 'idle':
      return queued === 0
        ? undefined
        : { text: `${String(queued)} queued`, short: `${String(queued)}q`, tone: 'muted' };
    case 'running': {
      const clock = formatClock(now - state.since);
      const t =
        state.tokens === undefined
          ? ''
          : ` · ${formatTokens(state.tokens.used)}/${formatTokens(state.tokens.budget)} tokens`;
      return {
        text: `● working ${clock}${t}${q}`,
        short: `● ${clock}`,
        tone:
          state.tokens !== undefined && state.tokens.used > state.tokens.budget * 0.8
            ? 'warning'
            : 'accent',
      };
    }
    case 'waiting': {
      const clock = formatClock(now - state.since);
      const more = state.more === 0 ? '' : ` (+${String(state.more)} more)`;
      return {
        text: `◆ ${WAITING[state.what]}${more} · ${clock}${q}`,
        short: `◆ ${clock}`,
        tone: 'warning',
      };
    }
    case 'ended': {
      const e = ENDED[state.status];
      const took = formatClock(state.durationMs);
      return {
        text: `${e.glyph} ${e.text} · ${took}${q}`,
        short: `${e.glyph} ${took}`,
        tone: e.tone,
      };
    }
  }
}
