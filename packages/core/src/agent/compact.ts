import type { ChatMessage } from '../providers/types.js';
import type { Router } from '../router/router.js';

/** Tool results this recent are always kept verbatim. */
const KEEP_RECENT_TOOL_RESULTS = 6;
const ELIDE_ABOVE_CHARS = 400;
/** Transcript sent to the summarizer; long tool outputs are clipped first. */
const TOOL_RESULT_IN_TRANSCRIPT = 1200;

/**
 * Cheap first step, no model call: replaces older, long tool outputs with a one-line note.
 * The model can rerun a tool if it needs the output again.
 */
export function elideToolOutputs(messages: readonly ChatMessage[]): {
  messages: ChatMessage[];
  elided: number;
} {
  const toolIdx = messages.flatMap((m, i) => (m.role === 'tool' ? [i] : []));
  const old = new Set(toolIdx.slice(0, Math.max(0, toolIdx.length - KEEP_RECENT_TOOL_RESULTS)));
  let elided = 0;
  const out = messages.map((m, i) => {
    if (
      m.role !== 'tool' ||
      !old.has(i) ||
      m.content.length <= ELIDE_ABOVE_CHARS ||
      m.content.startsWith('[output of')
    ) {
      return m;
    }
    elided++;
    return {
      ...m,
      content: `[output of ${m.name} removed to save context (${String(m.content.length)} characters); run the tool again if you need it]`,
    };
  });
  return { messages: out, elided };
}

/** Plain-text transcript for the summarizer. */
export function renderTranscript(messages: readonly ChatMessage[]): string {
  return messages
    .map((m) => {
      switch (m.role) {
        case 'user':
          return `USER:\n${m.content}`;
        case 'assistant': {
          const calls = (m.toolCalls ?? []).map((c) => `CALL ${c.name} ${c.arguments}`).join('\n');
          return `ASSISTANT:\n${[m.content, calls].filter((s) => s !== '').join('\n')}`;
        }
        case 'tool': {
          const body =
            m.content.length > TOOL_RESULT_IN_TRANSCRIPT
              ? `${m.content.slice(0, TOOL_RESULT_IN_TRANSCRIPT)} […]`
              : m.content;
          return `RESULT of ${m.name}:\n${body}`;
        }
        default:
          return '';
      }
    })
    .filter((s) => s !== '')
    .join('\n\n');
}

const SUMMARIZER = `You condense a coding session between a user and VinaX (a coding agent) so the work can continue in a fresh context. Keep every detail needed to carry on; drop chit-chat and raw tool output.

Write Markdown with exactly these sections:
## Goal
What the user wants, in their words where it matters.
## Decisions and constraints
Choices made, user preferences, things to avoid.
## Files
Each file read or changed, with what was learned or what changed (paths exact).
## Commands and results
Commands run and their outcome (e.g. which tests fail and why).
## Current state
Where the work stands right now.
## Next steps
What remains, in order.`;

/** Asks the (cheaper) small model for a structured summary of `messages`. */
export async function summarize(
  router: Router,
  messages: readonly ChatMessage[],
  opts: { signal: AbortSignal; instructions?: string },
): Promise<string> {
  const extra = opts.instructions?.trim()
    ? `\n\nThe user asked the summary to focus on: ${opts.instructions.trim()}`
    : '';
  let text = '';
  for await (const ev of router.stream({
    purpose: 'small',
    signal: opts.signal,
    maxTokens: 1500,
    messages: [
      { role: 'system', content: SUMMARIZER },
      {
        role: 'user',
        content: `Summarize this session.${extra}\n\n<session>\n${renderTranscript(messages)}\n</session>`,
      },
    ],
  })) {
    if (ev.type === 'text') text += ev.text;
  }
  const summary = text.trim();
  if (summary === '') throw new Error('The model returned an empty summary.');
  return summary;
}

/**
 * The compacted conversation: the summary is folded into the first message of `tail` (the
 * in-progress turn), or stands alone when there is no tail.
 */
export function applySummary(summary: string, tail: readonly ChatMessage[]): ChatMessage[] {
  const header = `<conversation-summary>\nEarlier conversation, condensed:\n\n${summary}\n</conversation-summary>`;
  const [first, ...rest] = tail;
  if (first?.role === 'user')
    return [{ role: 'user', content: `${header}\n\n${first.content}` }, ...rest];
  return [
    { role: 'user', content: `${header}\n\nContinue from where the summary leaves off.` },
    ...tail,
  ];
}
