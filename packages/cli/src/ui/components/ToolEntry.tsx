import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';
import type { ToolDisplay } from '@vinax/core';
import { truncate } from '../format.js';
import { renderMarkdown } from '../markdown.js';
import { useTheme } from '../theme.js';
import { DiffView } from './DiffView.js';
import { TodoList } from './TodoList.js';

function Header({
  name,
  label,
  color,
  glyph,
  width,
}: {
  name: string;
  label: string;
  color: string | undefined;
  glyph: string;
  width: number;
}) {
  return (
    <Text wrap="truncate-end">
      <Text color={color}>{glyph} </Text>
      <Text bold>{name}</Text>
      {label === '' ? '' : <Text> {truncate(label, Math.max(10, width - name.length - 4))}</Text>}
    </Text>
  );
}

/** A finished tool call: status line, one-line result, and a diff/checklist/plan when relevant. */
export function ToolEntry({
  name,
  label,
  ok,
  summary,
  display,
  width,
}: {
  name: string;
  label: string;
  ok: boolean;
  summary: string;
  display: ToolDisplay | undefined;
  width: number;
}) {
  const theme = useTheme();
  return (
    <Box flexDirection="column" marginTop={1}>
      <Header
        name={name}
        label={label}
        color={ok ? theme.success : theme.error}
        glyph="▸"
        width={width}
      />
      <Text color={ok ? theme.muted : theme.error} wrap="truncate-end">
        {'  └ '}
        {summary}
      </Text>
      {display?.kind === 'diff' ? (
        <Box paddingLeft={4}>
          <DiffView diff={display} maxLines={24} width={width - 4} />
        </Box>
      ) : null}
      {display?.kind === 'todos' ? (
        <Box paddingLeft={4}>
          <TodoList todos={display.todos} />
        </Box>
      ) : null}
      {display?.kind === 'plan' ? (
        <Box paddingLeft={4}>
          <Text>{renderMarkdown(display.plan, { width: width - 4, theme })}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

const SPINNER = ['○', '◔', '◑', '◕'];

/** A tool that is still running, with the last lines of its live output. */
export function RunningTool({
  name,
  label,
  output,
  width,
}: {
  name: string;
  label: string;
  output: string;
  width: number;
}) {
  const theme = useTheme();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => {
      setTick((n) => n + 1);
    }, 150);
    return () => {
      clearInterval(t);
    };
  }, []);
  const tail = output
    .split('\n')
    .filter((l) => l.trim() !== '')
    .slice(-4);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Header
        name={name}
        label={label}
        color={theme.accent}
        glyph={SPINNER[tick % SPINNER.length] ?? '○'}
        width={width}
      />
      {tail.map((l, i) => (
        <Text key={i} color={theme.muted} wrap="truncate-end">
          {'    '}
          {l}
        </Text>
      ))}
    </Box>
  );
}
