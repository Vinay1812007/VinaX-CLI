import { Box, Text } from 'ink';
import { useMemo } from 'react';
import { CATEGORY_LABELS, providerLabel, type FailureReport } from '@vinax/core';
import { renderMarkdown } from '../markdown.js';
import { useTheme } from '../theme.js';

export function UserMessage({ text }: { text: string }) {
  const theme = useTheme();
  return (
    <Box marginTop={1}>
      <Text color={theme.muted}>&gt; </Text>
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
  maxLines,
}: {
  markdown: string;
  first: boolean;
  width: number;
  /** Bound live output so a long code block cannot push controls below the viewport. */
  maxLines?: number;
}) {
  const theme = useTheme();
  const rendered = useMemo(
    () => renderMarkdown(markdown, { width: width - 2, theme }),
    [markdown, width, theme],
  );
  const lines = rendered.split('\n');
  const visible =
    maxLines !== undefined && lines.length > maxLines
      ? ['… streaming (full answer appears when complete)', ...lines.slice(-(maxLines - 1))].join(
          '\n',
        )
      : rendered;
  return (
    <Box marginTop={1}>
      <Box width={2} flexShrink={0}>
        <Text color={theme.accent}>{first ? '◆' : ' '}</Text>
      </Box>
      <Text>{visible}</Text>
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

/** A failed turn: what failed, per model, why, and what to try next. */
export function ErrorCard({ report, width }: { report: FailureReport; width: number }) {
  const theme = useTheme();
  return (
    <Box
      flexDirection="column"
      marginTop={1}
      borderStyle="round"
      borderColor={theme.error}
      paddingX={1}
      width={Math.min(width, 100)}
    >
      <Text color={theme.error} bold>
        ✖ {report.title}
      </Text>
      {report.lines.map((l, i) => (
        <Box
          key={`${l.provider}:${l.model}:${String(i)}`}
          flexDirection="column"
          marginTop={i === 0 ? 1 : 0}
        >
          <Text wrap="truncate-end">
            <Text bold>{providerLabel(l.provider)}</Text>
            <Text color={theme.muted}> · {l.model}</Text>
            <Text color={theme.warning}> — {CATEGORY_LABELS[l.category]}</Text>
          </Text>
          <Text color={theme.muted} wrap="wrap">
            {'  '}
            {l.reason}
          </Text>
        </Box>
      ))}
      {report.reason === undefined ? null : (
        <Box marginTop={1}>
          <Text wrap="wrap">
            <Text color={theme.muted}>Reason: </Text>
            {report.reason}
          </Text>
        </Box>
      )}
      {report.actions.length === 0 ? null : (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.muted}>Try</Text>
          {report.actions.map((a) => (
            <Text key={a} wrap="wrap">
              <Text color={theme.accent}>› </Text>
              {a}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}

/** The closing line of a turn that used tools. */
export function TurnSummary({ text }: { text: string }) {
  const theme = useTheme();
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={theme.success}>▸ </Text>
        <Text bold>Done</Text>
      </Text>
      <Text color={theme.muted} wrap="truncate-end">
        {'  └ '}
        {text}
      </Text>
    </Box>
  );
}

/** Left behind after the model reasoned: "✻ Thought for 4s". */
export function ThoughtLine({ durationMs }: { durationMs: number }) {
  const theme = useTheme();
  const secs = Math.max(1, Math.round(durationMs / 1000));
  return (
    <Box marginTop={1}>
      <Text color={theme.muted} italic>
        ✻ Thought for {secs}s
      </Text>
    </Box>
  );
}
