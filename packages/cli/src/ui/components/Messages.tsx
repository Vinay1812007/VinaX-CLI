import { Box, Text } from 'ink';
import { useMemo } from 'react';
import { renderMarkdown } from '../markdown.js';
import { useTheme } from '../theme.js';

export function UserMessage({ text }: { text: string }) {
  const theme = useTheme();
  return (
    <Box marginTop={1}>
      <Text color={theme.muted}>› </Text>
      <Text color={theme.muted} wrap="wrap">
        {text}
      </Text>
    </Box>
  );
}

/** One chunk of an answer. Only the first chunk carries the ◆ marker; the rest line up under it. */
export function AssistantMarkdown({
  markdown,
  first,
  width,
}: {
  markdown: string;
  first: boolean;
  width: number;
}) {
  const theme = useTheme();
  const rendered = useMemo(
    () => renderMarkdown(markdown, { width: width - 2, theme }),
    [markdown, width, theme],
  );
  return (
    <Box marginTop={1}>
      <Box width={2} flexShrink={0}>
        <Text color={theme.accent}>{first ? '◆' : ' '}</Text>
      </Box>
      <Text>{rendered}</Text>
    </Box>
  );
}

export function Notice({ level, text }: { level: 'info' | 'warning' | 'error'; text: string }) {
  const theme = useTheme();
  const color = level === 'error' ? theme.error : level === 'warning' ? theme.warning : theme.muted;
  const icon = level === 'error' ? '✖' : level === 'warning' ? '⚠' : '↪';
  return (
    <Box marginTop={1} paddingLeft={2}>
      <Text color={color} wrap="wrap">
        {icon} {text}
      </Text>
    </Box>
  );
}
