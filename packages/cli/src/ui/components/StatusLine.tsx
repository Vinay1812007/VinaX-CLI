import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import type { PermissionMode } from '@vinax/core';
import { truncate } from '../format.js';
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
  auto: 'edits, commands and web access inside the project run without asking; dangerous commands, deny rules and anything outside the project still ask',
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
  width: number;
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

export function StatusLine({ mode, model, contextPct, notice, hint, effort, width }: Props) {
  const theme = useTheme();
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
  const ctx = contextPct === undefined ? '' : ` · ${String(contextPct)}% context`;
  const eff = effort === undefined ? '' : ` · ${EFFORT_GLYPH[effort] ?? '◑'} ${effort}`;
  const left = hint ?? MODE_LABELS[mode];
  // Fit on one line: drop the shortcuts hint, then the cycle hint, then shorten the model.
  // Widths are terminal columns (⏸ and ⏵ take two), not string lengths.
  const inner = width - 2;
  const fixed = stringWidth(left) + stringWidth(ctx) + stringWidth(eff) + 2;
  const room = (extra: number): number => inner - fixed - extra;
  const want = Math.min(stringWidth(model), 24);
  const showCycle = hint === undefined && room(CYCLE_HINT.length) >= want;
  const showShortcuts = showCycle && room(CYCLE_HINT.length + SHORTCUTS_HINT.length) >= want;
  const used = (showCycle ? CYCLE_HINT.length : 0) + (showShortcuts ? SHORTCUTS_HINT.length : 0);
  const modelShown = truncate(model, Math.max(8, room(used)));
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text
          color={hint === undefined ? modeColor(mode, theme) : theme.warning}
          wrap="truncate-end"
        >
          {left}
          {showCycle ? <Text color={theme.muted}>{CYCLE_HINT}</Text> : ''}
          {showShortcuts ? <Text color={theme.muted}>{SHORTCUTS_HINT}</Text> : ''}
        </Text>
        <Text color={theme.muted} wrap="truncate-end">
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
