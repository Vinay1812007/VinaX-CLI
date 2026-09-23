import type { StatusNotice } from './components/StatusLine.js';

export type TranscriptItem =
  | { id: number; kind: 'welcome' }
  | { id: number; kind: 'user'; text: string }
  /** `first` marks the opening chunk of an answer (it gets the answer marker). */
  | { id: number; kind: 'assistant'; markdown: string; first: boolean }
  | { id: number; kind: 'notice'; level: StatusNotice['level']; text: string };

/** Per-turn details for the Ctrl+O view. */
export interface TurnRecord {
  prompt: string;
  model: string | undefined;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  durationMs: number;
  fallbacks: string[];
  status: 'done' | 'interrupted' | 'failed';
}

/**
 * Splits streamed Markdown at the last blank line outside a code fence. Everything before it is
 * complete and can be printed permanently; only the tail keeps re-rendering.
 */
export function splitStable(text: string): { stable: string; rest: string } {
  const lines = text.split('\n');
  let fence: string | undefined;
  let pos = 0;
  let cut = -1;
  // the last line may still be growing, so it never decides a split
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i] ?? '';
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (m?.[1]) {
      if (fence === undefined) fence = m[1];
      else if (m[1][0] === fence[0] && m[1].length >= fence.length) fence = undefined;
    }
    pos += line.length + 1;
    if (fence === undefined && line.trim() === '') cut = pos;
  }
  const stable = cut > 0 ? text.slice(0, cut).trimEnd() : '';
  return stable === '' ? { stable: '', rest: text } : { stable, rest: text.slice(cut) };
}
