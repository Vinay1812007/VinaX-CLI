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

/** Output of a slash command: a titled, bordered Markdown panel. */
export function Panel({
  title,
  markdown,
  width,
}: {
  title: string;
  markdown: string;
  width: number;
}) {
  const theme = useTheme();
  const rendered = useMemo(
    () => renderMarkdown(markdown, { width: width - 4, theme }),
    [markdown, width, theme],
  );
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.muted}
      paddingX={1}
      marginTop={1}
    >
      <Text bold color={theme.accent}>
        {title}
      </Text>
      <Text>{rendered}</Text>
    </Box>
  );
}

const SHELL_PREVIEW_LINES = 20;

/** A command the user ran with `!`, and its output (also given to the model as context). */
export function ShellEntry({
  command,
  output,
  exitCode,
}: {
  command: string;
  output: string;
  exitCode: number | undefined;
}) {
  const theme = useTheme();
  const lines = output.replace(/\s+$/, '').split('\n');
  const hidden = Math.max(0, lines.length - SHELL_PREVIEW_LINES);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={theme.warning}>! </Text>
        {command}
      </Text>
      {hidden > 0 ? <Text color={theme.muted}> … {hidden} earlier lines</Text> : null}
      {lines.slice(-SHELL_PREVIEW_LINES).map((l, i) => (
        <Text key={i} color={theme.muted} wrap="truncate-end">
          {'  '}
          {l}
        </Text>
      ))}
      {exitCode !== undefined && exitCode !== 0 ? (
        <Text color={theme.error}> exit code {exitCode}</Text>
      ) : null}
    </Box>
  );
}
