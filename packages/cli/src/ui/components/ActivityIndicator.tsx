import { Text } from 'ink';
import { useEffect, useState } from 'react';
import { formatDuration, formatTokens } from '../format.js';
import { useTheme } from '../theme.js';

const FRAMES = ['◇', '◈', '◆', '◈'];
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

interface Props {
  startedAt: number;
  /** Characters streamed so far; shown as an approximate token count. */
  outputChars: number;
  /** Set while the router waits for a rate-limit window. */
  waiting?: string | undefined;
  /** What is happening instead of the rotating verb, e.g. "Running Bash". */
  activity?: string | undefined;
  now?: () => number;
}

export function ActivityIndicator({
  startedAt,
  outputChars,
  waiting,
  activity,
  now = Date.now,
}: Props) {
  const theme = useTheme();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setTick((t) => t + 1);
    }, 150);
    return () => {
      clearInterval(timer);
    };
  }, []);

  const elapsed = now() - startedAt;
  const verb = VERBS[Math.floor(elapsed / 3000) % VERBS.length] ?? VERBS[0];
  const tokens = Math.round(outputChars / 4);
  const details = [
    formatDuration(elapsed),
    ...(tokens > 0 ? [`↓ ${formatTokens(tokens)} tokens`] : []),
    'esc to interrupt',
  ];
  return (
    <Text>
      <Text color={theme.accent}>{FRAMES[tick % FRAMES.length]} </Text>
      <Text color={waiting === undefined ? theme.accent : theme.warning}>
        {waiting ?? `${activity ?? verb}…`}
      </Text>
      <Text color={theme.muted}> ({details.join(' · ')})</Text>
    </Text>
  );
}
