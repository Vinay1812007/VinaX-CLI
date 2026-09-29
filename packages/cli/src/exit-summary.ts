import { formatDuration, formatTokens } from './ui/format.js';
import { paint, type CliIO } from './io.js';

/** What the session did, printed after the UI closes (like Claude Code's goodbye). */
export interface ExitSummary {
  sessionId: string;
  title: string | undefined;
  prompts: number;
  toolCalls: number;
  /** Wall-clock time the session was open. */
  wallMs: number;
  /** Time spent waiting for models and tools. */
  activeMs: number;
  inputTokens: number;
  outputTokens: number;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  models: string[];
}

/** Plain-text lines of the summary; `resume` is the command that continues the session. */
export function exitSummaryLines(s: ExitSummary): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  if (s.prompts === 0) return rows;
  rows.push({
    label: 'Session',
    value: `${s.sessionId}${s.title === undefined ? '' : ` · ${s.title}`}`,
  });
  rows.push({ label: 'Resume', value: `vinax --resume ${s.sessionId}` });
  rows.push({
    label: 'Time',
    value: `${formatDuration(s.wallMs)} total · ${formatDuration(s.activeMs)} working · ${String(s.prompts)} prompt${s.prompts === 1 ? '' : 's'} · ${String(s.toolCalls)} tool call${s.toolCalls === 1 ? '' : 's'}`,
  });
  if (s.inputTokens + s.outputTokens > 0)
    rows.push({
      label: 'Tokens',
      value: `${formatTokens(s.inputTokens)} in · ${formatTokens(s.outputTokens)} out`,
    });
  if (s.filesChanged > 0)
    rows.push({
      label: 'Changes',
      value: `${String(s.filesChanged)} file${s.filesChanged === 1 ? '' : 's'} · +${String(s.linesAdded)} −${String(s.linesRemoved)} lines`,
    });
  if (s.models.length > 0) rows.push({ label: 'Models', value: s.models.join(', ') });
  return rows;
}

/** Writes the goodbye block to stdout. */
export function writeExitSummary(io: CliIO, s: ExitSummary): void {
  const out = io.stdout;
  const rows = exitSummaryLines(s);
  if (rows.length === 0) {
    out.write(`${paint(out, 'cyan', '✻', io.env)} Bye!\n`);
    return;
  }
  const width = Math.max(...rows.map((r) => r.label.length)) + 2;
  out.write(
    `\n${paint(out, 'cyan', '✻', io.env)} ${paint(out, 'bold', 'Session saved', io.env)}\n`,
  );
  for (const r of rows) {
    const value = r.label === 'Resume' ? paint(out, 'cyan', r.value, io.env) : r.value;
    out.write(`  ${paint(out, 'dim', r.label.padEnd(width), io.env)}${value}\n`);
  }
  out.write('\n');
}
