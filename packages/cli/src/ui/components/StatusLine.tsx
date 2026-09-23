import { Box, Text } from 'ink';
import type { PermissionMode } from '@vinax/core';
import { truncate } from '../format.js';
import { useTheme, type Theme } from '../theme.js';

export const MODE_LABELS: Record<PermissionMode, string> = {
  default: '● default mode',
  acceptEdits: '✎ auto-accept edits',
  plan: '◇ plan mode',
};

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
  width: number;
}

function modeColor(mode: PermissionMode, theme: Theme): string | undefined {
  if (mode === 'acceptEdits') return theme.warning;
  if (mode === 'plan') return theme.accent;
  return theme.muted;
}

const CYCLE_HINT = ' (shift+tab to cycle)';

export function StatusLine({ mode, model, contextPct, notice, hint, width }: Props) {
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
  const left = hint ?? MODE_LABELS[mode];
  // Fit on one line: drop the cycle hint first, then shorten the model name.
  const inner = width - 2;
  const room = (withHint: boolean): number =>
    inner - left.length - (withHint ? CYCLE_HINT.length : 0) - ctx.length - 2;
  const showCycle = hint === undefined && room(true) >= Math.min(model.length, 24);
  const modelShown = truncate(model, Math.max(8, room(showCycle)));
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text
          color={hint === undefined ? modeColor(mode, theme) : theme.warning}
          wrap="truncate-end"
        >
          {left}
          {showCycle ? <Text color={theme.muted}>{CYCLE_HINT}</Text> : ''}
        </Text>
        <Text color={theme.muted} wrap="truncate-end">
          {modelShown}
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
