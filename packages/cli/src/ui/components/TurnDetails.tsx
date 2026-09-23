import { Box, Text } from 'ink';
import type { RateLimitSnapshot } from '@vinax/core';
import { formatDuration, formatTokens, truncate } from '../format.js';
import { useTheme } from '../theme.js';
import type { TurnRecord } from '../transcript.js';

interface Props {
  turns: readonly TurnRecord[];
  limits: readonly [string, RateLimitSnapshot][];
  /** How many turns to skip from the newest end (scroll position). */
  offset: number;
  height: number;
  width: number;
}

function limitLine(key: string, s: RateLimitSnapshot): string {
  const parts: string[] = [];
  if (s.tokens.remaining !== undefined && s.tokens.limit !== undefined) {
    parts.push(
      `${formatTokens(s.tokens.remaining)}/${formatTokens(s.tokens.limit)} tokens/min left`,
    );
  }
  if (s.requests.remaining !== undefined && s.requests.limit !== undefined) {
    parts.push(`${s.requests.remaining}/${s.requests.limit} requests left`);
  }
  return `${key}: ${parts.length === 0 ? 'no limit headers yet' : parts.join(', ')}`;
}

/** Ctrl+O: which model answered each turn, tokens, timing, fallbacks and live rate limits. */
export function TurnDetails({ turns, limits, offset, height, width }: Props) {
  const theme = useTheme();
  const perTurn = 3;
  const visible = Math.max(1, Math.floor((height - 6 - limits.length) / perTurn));
  const end = turns.length - offset;
  const shown = turns.slice(Math.max(0, end - visible), end);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.muted} paddingX={1}>
      <Text bold>
        Turn details <Text color={theme.muted}>(↑/↓ scroll · Esc or Ctrl+O to close)</Text>
      </Text>
      {shown.length === 0 ? <Text color={theme.muted}>No turns yet.</Text> : null}
      {shown.map((t, i) => (
        <Box key={String(end - shown.length + i)} flexDirection="column" marginTop={1}>
          <Text wrap="truncate-end">› {truncate(t.prompt, width - 8)}</Text>
          <Text color={theme.muted}>
            {'  '}
            {t.model ?? 'no model answered'} · {formatDuration(t.durationMs)}
            {t.inputTokens === undefined
              ? ''
              : ` · ${formatTokens(t.inputTokens)} in / ${formatTokens(t.outputTokens ?? 0)} out`}
            {t.status === 'done' ? '' : ` · ${t.status}`}
          </Text>
          {t.fallbacks.length === 0 ? null : (
            <Text color={theme.warning} wrap="truncate-end">
              {'  '}fallback: {t.fallbacks.join(' → ')}
            </Text>
          )}
        </Box>
      ))}
      {limits.length === 0 ? null : (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.muted}>Rate limits</Text>
          {limits.map(([key, snap]) => (
            <Text key={key} color={theme.muted} wrap="truncate-end">
              {'  '}
              {limitLine(key, snap)}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
