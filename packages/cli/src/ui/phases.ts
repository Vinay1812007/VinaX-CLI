/** Stages of an agent turn, shown as progress ("Inspecting → Editing → Running tests"). */
export type Phase =
  | 'Inspecting repository'
  | 'Planning'
  | 'Editing'
  | 'Running tests'
  | 'Running commands'
  | 'Delegating to a sub-agent'
  | 'Reading the web'
  | 'Using tools';

const TEST_COMMAND =
  /\b(test|tests|vitest|jest|pytest|mocha|ava|tap|rspec|phpunit|ctest|go test|cargo test|dotnet test|mvn test|gradle test|npm t)\b/i;

/** The phase a tool call belongs to; `label` is the call's one-line description. */
export function phaseFor(tool: string, label: string): Phase {
  switch (tool) {
    case 'Read':
    case 'Glob':
    case 'Grep':
    case 'LS':
      return 'Inspecting repository';
    case 'TodoWrite':
    case 'ExitPlanMode':
      return 'Planning';
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      return 'Editing';
    case 'Bash':
    case 'BashOutput':
      return TEST_COMMAND.test(label) ? 'Running tests' : 'Running commands';
    case 'Task':
      return 'Delegating to a sub-agent';
    case 'WebFetch':
      return 'Reading the web';
    default:
      return 'Using tools';
  }
}

/** Appends `phase` unless it repeats the last one; keeps the trail short. */
export function extendTrail(trail: readonly Phase[], phase: Phase, max = 5): Phase[] {
  if (trail.at(-1) === phase) return [...trail];
  return [...trail, phase].slice(-max);
}

/** Tool results that are the user's (or a hook's) decision rather than a tool error. */
const CONTROL = new Set(['Denied', 'Declined', 'Blocked by a hook', 'Skipped', 'Interrupted']);

export type ToolOutcome = 'ok' | 'blocked' | 'error';

export function toolOutcome(ok: boolean, summary: string): ToolOutcome {
  if (ok) return 'ok';
  return CONTROL.has(summary) ? 'blocked' : 'error';
}

const FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write']);

/** "Updated 3 files · 7 tool calls · 12s" for the end-of-turn summary. */
export function turnSummary(
  tools: readonly { name: string; label: string; ok: boolean }[],
  durationMs: number,
): string {
  const files = new Set(tools.filter((t) => t.ok && FILE_TOOLS.has(t.name)).map((t) => t.label));
  const failed = tools.filter((t) => !t.ok).length;
  const parts = [
    files.size === 0
      ? 'No files changed'
      : `Updated ${String(files.size)} file${files.size === 1 ? '' : 's'}`,
    `${String(tools.length)} tool call${tools.length === 1 ? '' : 's'}`,
    ...(failed === 0 ? [] : [`${String(failed)} not completed`]),
    formatSeconds(durationMs),
  ];
  return parts.join(' · ');
}

export function formatSeconds(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 60))}m ${String(s % 60).padStart(2, '0')}s`;
}

/** Adds the duration to a tool summary that does not already state one (Bash does). */
export function withDuration(summary: string, ms: number | undefined): string {
  if (ms === undefined || ms < 1000 || /\b\d+(\.\d+)?s\b/.test(summary)) return summary;
  return `${summary} · ${formatSeconds(ms)}`;
}
