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
  /** Tokens the providers reported. */
  inputTokens: number;
  outputTokens: number;
  /** Tokens VinaX had to estimate (responses without a usage report). */
  estimatedTokens?: number;
  /** "$0.0123", "unknown (no price for …)"; omitted when no tokens were used. */
  cost?: string;
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
  const estimated = s.estimatedTokens ?? 0;
  if (s.inputTokens + s.outputTokens + estimated > 0)
    rows.push({
      label: 'Tokens',
      value: [
        s.inputTokens + s.outputTokens === 0
          ? undefined
          : `${formatTokens(s.inputTokens)} in · ${formatTokens(s.outputTokens)} out (reported)`,
        estimated === 0 ? undefined : `~${formatTokens(estimated)} estimated`,
      ]
        .filter((x): x is string => x !== undefined)
        .join(' · '),
    });
  if (s.cost !== undefined) rows.push({ label: 'Cost', value: s.cost });
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
