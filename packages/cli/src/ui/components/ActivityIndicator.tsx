import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';
import { formatDuration, formatTokens, truncate } from '../format.js';
import { useTheme, type Theme } from '../theme.js';

/** A pulsing star, like Claude Code's spinner: it grows, then shrinks back. */
export const SPINNER_FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
const VERBS = [
  'Thinking',
  'Pondering',
  'Untangling',
  'Sketching',
  'Connecting dots',
  'Weighing options',
  'Drafting',
  'Tinkering',
];
const FRAME_MS = 120;

interface Props {
  startedAt: number;
  /** Characters streamed so far; shown as an approximate token count. */
  outputChars: number;
  /** Set while the router waits for a rate-limit window. */
  waiting?: string | undefined;
  /** What is happening instead of the rotating verb, e.g. "Running tests". */
  activity?: string | undefined;
  /** Stages this turn went through so far, e.g. ["Inspecting repository", "Editing"]. */
  trail?: readonly string[];
  /** The tail of the model's reasoning while it thinks. */
  thinking?: string | undefined;
  /** Reasoning effort in use, shown next to the timer. */
  effort?: string | undefined;
  now?: () => number;
  width?: number;
}

/** Colours for a shimmer: a brighter band sweeps across the text. */
function shimmerColors(theme: Theme): { base: string | undefined; bright: string | undefined } {
  if (!theme.color) return { base: undefined, bright: undefined };
  return theme.name === 'light'
    ? { base: theme.accent, bright: '#134E4A' }
    : { base: theme.accent, bright: '#CCFBF1' };
}

/** Text with a highlight band at `pos` (moving one character per frame). */
export function Shimmer({ text, tick }: { text: string; tick: number }) {
  const theme = useTheme();
  const { base, bright } = shimmerColors(theme);
  if (!theme.color) return <Text>{text}</Text>;
  const span = text.length + 8;
  const pos = (tick % span) - 4;
  return (
    <Text>
      {Array.from(text).map((ch, i) => (
        <Text key={i} color={Math.abs(i - pos) <= 1 ? bright : base}>
          {ch}
        </Text>
      ))}
    </Text>
  );
}

export function ActivityIndicator({
  startedAt,
  outputChars,
  waiting,
  activity,
  trail = [],
  thinking,
  effort,
  now = Date.now,
  width = 80,
}: Props) {
  const theme = useTheme();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setTick((t) => t + 1);
    }, FRAME_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);

  const elapsed = now() - startedAt;
  const verb =
    thinking !== undefined
      ? 'Thinking'
      : (VERBS[Math.floor(elapsed / 3000) % VERBS.length] ?? 'Thinking');
  const tokens = Math.round(outputChars / 4);
  const details = [
    formatDuration(elapsed),
    ...(tokens > 0 ? [`↓ ${formatTokens(tokens)} tokens`] : []),
    ...(effort === undefined ? [] : [`${effort} effort`]),
    'esc to interrupt',
  ];
  const glyph = SPINNER_FRAMES[tick % SPINNER_FRAMES.length] ?? '✻';
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={waiting === undefined ? theme.accent : theme.warning}>{glyph} </Text>
        {waiting === undefined ? (
          <Shimmer text={`${activity ?? verb}…`} tick={tick} />
        ) : (
          <Text color={theme.warning}>{waiting}</Text>
        )}
        <Text color={theme.muted}> ({details.join(' · ')})</Text>
      </Text>
      {thinking === undefined || thinking.trim() === '' ? null : (
        <Text color={theme.muted} italic wrap="truncate-end">
          {'  ⎿ '}
          {truncate(
            thinking
              .split('\n')
              .filter((l) => l.trim() !== '')
              .at(-1) ?? '',
            width - 6,
          )}
        </Text>
      )}
      {trail.length < 2 ? null : (
        <Text color={theme.muted} wrap="truncate-start">
          {'  '}
          {trail.join(' → ')}
        </Text>
      )}
    </Box>
  );
}
