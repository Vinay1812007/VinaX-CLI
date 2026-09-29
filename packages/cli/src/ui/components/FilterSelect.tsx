import { Box, Text, useInput } from 'ink';
import { useMemo, useState } from 'react';
import { fuzzyScore } from '@vinax/core';
import { isPrintable } from '../keys.js';
import { truncate } from '../format.js';
import { useTheme } from '../theme.js';
import type { SelectItem } from './Select.js';

/** Every word of the query must fuzzy-match the label, hint, group or a keyword. */
export function filterItems<T>(items: readonly SelectItem<T>[], query: string): SelectItem<T>[] {
  const words = query
    .trim()
    .split(/\s+/)
    .filter((w) => w !== '');
  if (words.length === 0) return [...items];
  return items.filter((item) => {
    const fields = [item.label, item.hint ?? '', item.group ?? '', ...(item.keywords ?? [])];
    return words.every((w) => fields.some((f) => fuzzyScore(w, f) !== undefined));
  });
}

type Row<T> = { kind: 'group'; label: string } | { kind: 'item'; item: SelectItem<T>; at: number };

function rowsFor<T>(items: readonly SelectItem<T>[]): Row<T>[] {
  const rows: Row<T>[] = [];
  let group: string | undefined;
  for (const [at, item] of items.entries()) {
    if (item.group !== undefined && item.group !== group) {
      group = item.group;
      rows.push({ kind: 'group', label: group });
    }
    rows.push({ kind: 'item', item, at });
  }
  return rows;
}

interface Props<T> {
  items: readonly SelectItem<T>[];
  onSelect: (value: T) => void;
  /** Rows shown at once (headings included). */
  visibleCount?: number;
  width: number;
  isActive?: boolean;
}

/**
 * A picker with type-to-filter search and grouped items. Typing filters, ↑/↓ move between
 * choosable items, Enter picks, Backspace edits the query and Ctrl+U clears it.
 */
export function FilterSelect<T>({
  items,
  onSelect,
  visibleCount = 12,
  width,
  isActive = true,
}: Props<T>) {
  const theme = useTheme();
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => filterItems(items, query), [items, query]);
  const selectable = filtered.flatMap((item, i) => (item.disabled === true ? [] : [i]));
  const initial = Math.max(
    0,
    selectable.findIndex((i) => filtered[i]?.current === true),
  );
  const [cursor, setCursor] = useState(initial);
  const pos = Math.min(cursor, Math.max(0, selectable.length - 1));
  const selectedAt = selectable[pos];

  useInput(
    (input, key) => {
      if (key.upArrow || key.downArrow) {
        if (selectable.length === 0) return;
        const next = (pos + (key.upArrow ? -1 : 1) + selectable.length) % selectable.length;
        setCursor(next);
      } else if (key.return) {
        const item = selectedAt === undefined ? undefined : filtered[selectedAt];
        if (item) onSelect(item.value);
      } else if (key.backspace || key.delete) {
        setQuery((q) => q.slice(0, -1));
        setCursor(0);
      } else if (key.ctrl && input === 'u') {
        setQuery('');
        setCursor(0);
      } else if (!key.ctrl && !key.meta && !key.escape && !key.tab && isPrintable(input)) {
        setQuery((q) => q + input);
        setCursor(0);
      }
    },
    { isActive },
  );

  const rows = rowsFor(filtered);
  const selectedRow = rows.findIndex((r) => r.kind === 'item' && r.at === selectedAt);
  const first = Math.min(
    Math.max(0, selectedRow - Math.floor(visibleCount / 2)),
    Math.max(0, rows.length - visibleCount),
  );
  const shown = rows.slice(first, first + visibleCount);
  const labelWidth = Math.min(
    Math.max(12, Math.floor(width * 0.5)),
    Math.max(8, ...filtered.map((i) => i.label.length)) + 1,
  );
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={theme.accent}>⌕ </Text>
        {query === '' ? <Text color={theme.muted}>type to filter</Text> : <Text>{query}</Text>}
        <Text color={theme.muted}>
          {' '}
          · {filtered.length} of {items.length}
        </Text>
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {filtered.length === 0 ? <Text color={theme.muted}> No matches.</Text> : null}
        {first > 0 ? <Text color={theme.muted}> ↑ {first} more</Text> : null}
        {shown.map((row, i) => {
          if (row.kind === 'group') {
            return (
              <Text key={`g:${row.label}:${String(i)}`} bold color={theme.muted}>
                {row.label}
              </Text>
            );
          }
          const { item } = row;
          const selected = row.at === selectedAt;
          const dim = item.disabled === true;
          return (
            <Box key={`i:${String(row.at)}:${item.label}`}>
              <Box flexShrink={0}>
                <Text
                  color={selected ? theme.accent : dim ? theme.muted : undefined}
                  bold={selected}
                  dimColor={dim && !theme.color}
                >
                  {selected ? '❯ ' : '  '}
                  {item.current === true ? '● ' : '  '}
                  {truncate(item.label, labelWidth).padEnd(labelWidth)}
                </Text>
              </Box>
              {item.hint === undefined ? null : (
                <Text color={theme.muted} wrap="truncate-end">
                  {' '}
                  {item.hint}
                </Text>
              )}
            </Box>
          );
        })}
        {first + shown.length < rows.length ? (
          <Text color={theme.muted}> ↓ {rows.length - first - shown.length} more</Text>
        ) : null}
      </Box>
    </Box>
  );
}
