import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';
import type { ToolDisplay } from '@vinax/core';
import { truncate } from '../format.js';
import { toolOutcome, withDuration } from '../phases.js';
import { renderMarkdown } from '../markdown.js';
import { useTheme } from '../theme.js';
import { EXPAND_MAX_LINES } from '../expand.js';
import { DIFF_PREVIEW_LINES, DiffView, diffRows } from './DiffView.js';
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

/**
 * What to add after a tool's summary when the output is not shown. Most summaries already count
 * the lines ("Exit 0 · 4 lines"), so the count is only repeated when the summary left it out.
 */
export function hiddenHint(summary: string, hidden: number): string {
  const counted = summary.includes(`${String(hidden)} line`);
  return counted ? ' (ctrl+x to expand)' : ` … +${String(hidden)} lines (ctrl+x to expand)`;
}

/** A finished tool call: status line, one-line result, and a diff/checklist/plan when relevant. */
export function ToolEntry({
  name,
  label,
  ok,
  summary,
  display,
  durationMs,
  hidden = 0,
  width,
}: {
  name: string;
  label: string;
  ok: boolean;
  summary: string;
  display: ToolDisplay | undefined;
  durationMs?: number | undefined;
  /** Lines this entry does not show, offered with Ctrl+X (diffs say so under the diff instead). */
  hidden?: number;
  width: number;
}) {
  const theme = useTheme();
  // a denied or declined call is the user's decision, not a tool error: show it differently
  const outcome = toolOutcome(ok, summary);
  const color =
    outcome === 'ok' ? theme.success : outcome === 'blocked' ? theme.warning : theme.error;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Header
        name={name}
        label={label}
        color={color}
        glyph={outcome === 'ok' ? '▸' : outcome === 'blocked' ? '⊘' : '✖'}
        width={width}
      />
      <Text color={outcome === 'ok' ? theme.muted : color} wrap="truncate-end">
        {'  └ '}
        {withDuration(summary, durationMs)}
        {display === undefined && hidden > 0 ? (
          <Text color={theme.muted}>{hiddenHint(summary, hidden)}</Text>
        ) : (
          ''
        )}
      </Text>
      {display?.kind === 'diff' ? (
        <Box paddingLeft={4}>
          <DiffView
            diff={display}
            maxLines={DIFF_PREVIEW_LINES}
            width={width - 4}
            moreHint="ctrl+x to expand"
          />
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
      {display?.kind === 'question' ? (
        <Box paddingLeft={4} flexDirection="column">
          <Text>{display.question}</Text>
          <Text color={theme.accent}>Your answer: {display.answer}</Text>
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
  active = true,
}: {
  name: string;
  label: string;
  output: string;
  width: number;
  active?: boolean;
}) {
  const theme = useTheme();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      setTick((n) => n + 1);
    }, 150);
    return () => {
      clearInterval(t);
    };
  }, [active]);
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
        glyph={active ? (SPINNER[tick % SPINNER.length] ?? '○') : '⏸'}
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

/** A tool result reprinted in full, after Ctrl+X asked for the lines the entry left out. */
export function ExpandedOutput({
  title,
  diff,
  text,
  width,
}: {
  title: string;
  diff?: Extract<ToolDisplay, { kind: 'diff' }> | undefined;
  text?: string | undefined;
  width: number;
}) {
  const theme = useTheme();
  const lines = text === undefined ? [] : text.replace(/\s+$/, '').split('\n');
  const shown = lines.slice(0, EXPAND_MAX_LINES);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.accent} wrap="truncate-end">
        ⤷ {truncate(title, Math.max(10, width - 4))}
      </Text>
      {diff === undefined ? null : (
        <Box paddingLeft={2}>
          <DiffView diff={diff} maxLines={diffRows(diff)} width={width - 2} />
        </Box>
      )}
      {shown.map((l, i) => (
        <Text key={i} wrap="truncate-end">
          {'  '}
          {l}
        </Text>
      ))}
      {lines.length > shown.length ? (
        <Text color={theme.muted}>
          {'  '}… {lines.length - shown.length} more lines (ctrl+o to read all of it)
        </Text>
      ) : null}
    </Box>
  );
}
