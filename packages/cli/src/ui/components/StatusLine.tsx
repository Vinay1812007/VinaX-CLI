import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';
import stringWidth from 'string-width';
import type { PermissionMode } from '@vinax/core';
import { truncate } from '../format.js';
import { taskChip, type TaskChip, type TaskState } from '../task-state.js';
import { useTheme, type Theme } from '../theme.js';

/** The footer's mode indicator, like Claude Code's: glyph + name + "on". */
export const MODE_LABELS: Record<PermissionMode, string> = {
  default: '⏸ manual mode on',
  acceptEdits: '⏵⏵ accept edits on',
  plan: '⏸ plan mode on',
  auto: '⏵⏵ auto mode on',
};

/** What each mode means, for /permissions and the shortcuts help. */
export const MODE_DESCRIPTIONS: Record<PermissionMode, string> = {
  default: 'asks before edits, commands and web access',
  acceptEdits: 'edits inside the project are applied without asking',
  plan: 'read-only: VinaX researches and proposes a plan first',
  auto: 'edits, commands and web access inside the project run without asking; dangerous commands and outside-project access still ask; deny rules still block',
};

/** Shift+Tab cycles through these. */
export const MODE_CYCLE: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan', 'auto'];

export interface StatusNotice {
  level: 'info' | 'warning' | 'error';
  text: string;
}

interface Props {
  mode: PermissionMode;
  model: string;
  contextPct: number | undefined;
  notice: StatusNotice | undefined;
  /** Transient hint that replaces the mode label, e.g. "Press Ctrl+C again to exit". */
  hint: string | undefined;
  /** Reasoning effort, when set (e.g. "high"). */
  effort?: string | undefined;
  /** What the session is doing (working, waiting for you, how the last turn ended). */
  task?: TaskState | undefined;
  /** Messages typed while busy, waiting to be sent. */
  queued?: number;
  now?: () => number;
  width: number;
}

/** Re-renders once a second while `active`, so running clocks move. */
function useTicker(active: boolean, now: () => number): number {
  const [t, setT] = useState(now());
  useEffect(() => {
    if (!active) return;
    setT(now());
    const timer = setInterval(() => {
      setT(now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [active]);
  return active ? t : now();
}

function chipColor(chip: TaskChip, theme: Theme): string | undefined {
  return chip.tone === 'muted' ? theme.muted : theme[chip.tone];
}

export function modeColor(mode: PermissionMode, theme: Theme): string | undefined {
  if (!theme.color) return undefined;
  switch (mode) {
    case 'acceptEdits':
      return theme.name === 'light' ? '#7C3AED' : '#A78BFA';
    case 'plan':
      return theme.accent;
    case 'auto':
      return theme.warning;
    case 'default':
      return theme.muted;
  }
}

const CYCLE_HINT = ' (shift+tab to cycle)';
const SHORTCUTS_HINT = ' · ? for shortcuts';
const EFFORT_GLYPH: Record<string, string> = { low: '◔', medium: '◑', high: '●' };

export function StatusLine({
  mode,
  model,
  contextPct,
  notice,
  hint,
  effort,
  task = { kind: 'idle' },
  queued = 0,
  now = Date.now,
  width,
}: Props) {
  const theme = useTheme();
  const ticking = task.kind === 'running' || task.kind === 'waiting';
  const at = useTicker(ticking, now);
  const chip = taskChip(task, queued, at);
  const noticeColor =
    notice?.level === 'error'
      ? theme.error
      : notice?.level === 'warning'
        ? theme.warning
        : theme.muted;
  const ctxColor =
    contextPct === undefined || contextPct < 70
      ? theme.muted
      : contextPct < 85
        ? theme.warning
        : theme.error;
  let ctx = contextPct === undefined ? '' : ` · ${String(contextPct)}% context`;
  let eff = effort === undefined ? '' : ` · ${EFFORT_GLYPH[effort] ?? '◑'} ${effort}`;
  const left = hint ?? MODE_LABELS[mode];
  // Fit on one line: drop the shortcuts hint, then the cycle hint, then shorten the model.
  // Widths are terminal columns (⏸ and ⏵ take two), not string lengths.
  const inner = Math.max(1, width - 2);
  let chipText = chip === undefined ? '' : `${chip.text} · `;
  if (chip !== undefined && stringWidth(left + chipText + ctx + eff) + 10 > inner)
    chipText = `${chip.short} · `;
  if (stringWidth(left + chipText + ctx + eff) + 10 > inner) eff = '';
  if (stringWidth(left + chipText + ctx) + 10 > inner) ctx = '';
  const fixed = stringWidth(left) + stringWidth(chipText) + stringWidth(ctx) + stringWidth(eff) + 2;
  const room = (extra: number): number => inner - fixed - extra;
  const want = Math.min(stringWidth(model), 24);
  const showCycle = hint === undefined && room(CYCLE_HINT.length) >= want;
  const showShortcuts = showCycle && room(CYCLE_HINT.length + SHORTCUTS_HINT.length) >= want;
  const used = (showCycle ? CYCLE_HINT.length : 0) + (showShortcuts ? SHORTCUTS_HINT.length : 0);
  const modelShown = room(used) > 0 ? truncate(model, room(used)) : '';
  return (
    <Box flexDirection="column" paddingX={1} width={width}>
      <Box justifyContent="space-between">
        <Text
          color={hint === undefined ? modeColor(mode, theme) : theme.warning}
          wrap="truncate-end"
        >
          {truncate(left, inner)}
          {showCycle ? <Text color={theme.muted}>{CYCLE_HINT}</Text> : ''}
          {showShortcuts ? <Text color={theme.muted}>{SHORTCUTS_HINT}</Text> : ''}
        </Text>
        <Text color={theme.muted} wrap="truncate-end">
          {chip === undefined || chipText === '' ? (
            ''
          ) : (
            <Text color={chipColor(chip, theme)}>{chipText.slice(0, -3)}</Text>
          )}
          {chipText === '' ? '' : ' · '}
          {modelShown}
          {eff === '' ? '' : <Text color={theme.accent}>{eff}</Text>}
          {ctx === '' ? '' : <Text color={ctxColor}>{ctx}</Text>}
        </Text>
      </Box>
      {notice === undefined ? null : (
        <Text color={noticeColor} wrap="truncate-end">
          {notice.text}
        </Text>
      )}
    </Box>
  );
}
