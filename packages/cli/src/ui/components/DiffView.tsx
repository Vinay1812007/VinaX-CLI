import { Box, Text } from 'ink';
import type { ToolDisplay } from '@vinax/core';
import { useTheme } from '../theme.js';

type Diff = Extract<ToolDisplay, { kind: 'diff' }>;

/** Diff lines a finished tool entry shows before offering the rest. */
export const DIFF_PREVIEW_LINES = 24;

/** Every row a diff would print: its lines, plus a `⋮` between hunks. */
export function diffRows(diff: Diff): number {
  return diff.hunks.reduce((n, h, i) => n + h.lines.length + (i > 0 ? 1 : 0), 0);
}

interface Props {
  diff: Diff;
  /** Lines shown before "… N more lines". */
  maxLines: number;
  width: number;
  /** Lines scrolled past from the top. */
  offset?: number;
  /**
   * Where to see the rest, after "… N more lines". The default says nothing, because most views
   * own the keyboard while they are open; callers that can offer a key pass one.
   */
  moreHint?: string;
}

/** A coloured unified diff with line numbers. */
export function DiffView({ diff, maxLines, width, offset = 0, moreHint = 'shortened' }: Props) {
  const theme = useTheme();
  const all = diff.hunks.flatMap((h, i) => [
    ...(i > 0 ? [{ kind: 'gap' as const }] : []),
    ...h.lines.map((l) => ({ kind: 'line' as const, line: l })),
  ]);
  const start = Math.min(Math.max(0, offset), Math.max(0, all.length - maxLines));
  const shown = all.slice(start, start + maxLines);
  const numWidth = Math.max(
    3,
    ...diff.hunks.flatMap((h) => h.lines.map((l) => String(l.newLine ?? l.oldLine ?? '').length)),
  );
  return (
    <Box flexDirection="column">
      {start > 0 ? (
        <Text color={theme.muted}>
          {' '.repeat(numWidth)} ↑ {start} lines above
        </Text>
      ) : null}
      {shown.map((row, i) => {
        if (row.kind === 'gap') {
          return (
            <Text key={i} color={theme.muted}>
              {' '.repeat(numWidth)} ⋮
            </Text>
          );
        }
        const l = row.line;
        const num = String(l.kind === 'remove' ? (l.oldLine ?? '') : (l.newLine ?? '')).padStart(
          numWidth,
        );
        const sign = l.kind === 'add' ? '+' : l.kind === 'remove' ? '-' : ' ';
        const color =
          l.kind === 'add' ? theme.success : l.kind === 'remove' ? theme.error : undefined;
        return (
          <Text key={i} wrap="truncate-end">
            <Text color={theme.muted}>{num} </Text>
            <Text color={color} dimColor={l.kind === 'context'}>
              {sign} {l.text.replace(/\t/g, '  ').slice(0, Math.max(10, width - numWidth - 3))}
            </Text>
          </Text>
        );
      })}
      {all.length > start + shown.length ? (
        <Text color={theme.muted}>
          {' '.repeat(numWidth)} … {all.length - start - shown.length} more lines ({moreHint})
        </Text>
      ) : null}
    </Box>
  );
}
