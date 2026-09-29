import type { DoctorCheck, DoctorGroup } from '@vinax/core';
import { paint, type CliIO } from './io.js';

export const CHECK_ICON = { ok: '✔', warn: '⚠', fail: '✖', skip: '○' } as const;

export const GROUP_LABELS: Record<DoctorGroup, string> = {
  runtime: 'Runtime',
  providers: 'Providers & models',
  tools: 'Tools',
  integrations: 'Integrations',
};

const GROUP_ORDER: readonly DoctorGroup[] = ['runtime', 'providers', 'tools', 'integrations'];

export function healthSummary(checks: readonly DoctorCheck[]): string {
  const count = (s: DoctorCheck['status']) => checks.filter((c) => c.status === s).length;
  const plural = (n: number, w: string) => `${String(n)} ${w}${n === 1 ? '' : 's'}`;
  return [
    `${String(count('ok'))} ok`,
    plural(count('warn'), 'warning'),
    plural(count('fail'), 'failure'),
    ...(count('skip') > 0 ? [`${String(count('skip'))} not set up`] : []),
  ].join(' · ');
}

/** Checks in display order, grouped. */
export function groupChecks(
  checks: readonly DoctorCheck[],
): { group: DoctorGroup; label: string; checks: DoctorCheck[] }[] {
  return GROUP_ORDER.map((group) => ({
    group,
    label: GROUP_LABELS[group],
    checks: checks.filter((c) => c.group === group),
  })).filter((g) => g.checks.length > 0);
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, Math.max(1, max - 1))}…`;
}

/** `vinax health`: a grouped, one-line-per-check summary that fits the terminal. */
export function writeHealth(io: CliIO, checks: readonly DoctorCheck[], columns = 80): void {
  const out = io.stdout;
  const style = { ok: 'green', warn: 'yellow', fail: 'red', skip: 'dim' } as const;
  const nameWidth = Math.max(...checks.map((c) => c.name.length)) + 2;
  out.write(`${paint(out, 'bold', 'VinaX health', io.env)}  ${healthSummary(checks)}\n`);
  for (const g of groupChecks(checks)) {
    out.write(`\n${paint(out, 'dim', g.label, io.env)}\n`);
    for (const c of g.checks) {
      const detail = clip(c.detail, Math.max(20, columns - nameWidth - 6));
      out.write(
        `  ${paint(out, style[c.status], CHECK_ICON[c.status], io.env)} ${c.name.padEnd(nameWidth)}${detail}\n`,
      );
    }
  }
}

/** `/health`: the same summary as Markdown for a panel. */
export function healthMarkdown(checks: readonly DoctorCheck[]): string {
  const lines = [`**${healthSummary(checks)}**`];
  for (const g of groupChecks(checks)) {
    lines.push('', `_${g.label}_`);
    for (const c of g.checks)
      lines.push(`- ${CHECK_ICON[c.status]} **${c.name}** — ${clip(c.detail, 110)}`);
  }
  lines.push('', 'Full details: `/doctor`');
  return lines.join('\n');
}
