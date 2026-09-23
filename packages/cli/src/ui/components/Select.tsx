import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { useTheme } from '../theme.js';

export interface SelectItem<T> {
  label: string;
  value: T;
  hint?: string;
}

interface Props<T> {
  items: readonly SelectItem<T>[];
  initialIndex?: number;
  isActive?: boolean;
  /** Rows shown at once; the list scrolls to keep the highlighted row visible. */
  visibleCount?: number;
  onSelect: (value: T) => void;
  onHighlight?: (value: T) => void;
}

/** Arrow keys (or j/k) move, Enter picks, 1–9 picks directly. */
export function Select<T>({
  items,
  initialIndex = 0,
  isActive = true,
  visibleCount = 10,
  onSelect,
  onHighlight,
}: Props<T>) {
  const theme = useTheme();
  const [index, setIndex] = useState(Math.min(Math.max(0, initialIndex), items.length - 1));

  const move = (next: number): void => {
    const wrapped = (next + items.length) % items.length;
    setIndex(wrapped);
    const item = items[wrapped];
    if (item) onHighlight?.(item.value);
  };

  useInput(
    (input, key) => {
      if (key.upArrow || input === 'k') move(index - 1);
      else if (key.downArrow || input === 'j') move(index + 1);
      else if (key.return) {
        const item = items[index];
        if (item) onSelect(item.value);
      } else if (/^[1-9]$/.test(input)) {
        const item = items[Number(input) - 1];
        if (item) onSelect(item.value);
      }
    },
    { isActive },
  );

  const first = Math.min(
    Math.max(0, index - Math.floor(visibleCount / 2)),
    Math.max(0, items.length - visibleCount),
  );
  const shown = items.slice(first, first + visibleCount);
  return (
    <Box flexDirection="column">
      {first > 0 ? <Text color={theme.muted}> ↑ {first} more</Text> : null}
      {shown.map((item, offset) => {
        const i = first + offset;
        const selected = i === index;
        return (
          <Box key={item.label}>
            <Text color={selected ? theme.accent : undefined} bold={selected}>
              {selected ? '❯ ' : '  '}
              {i + 1}. {item.label}
            </Text>
            {item.hint === undefined ? null : <Text color={theme.muted}> {item.hint}</Text>}
          </Box>
        );
      })}
      {first + shown.length < items.length ? (
        <Text color={theme.muted}> ↓ {items.length - first - shown.length} more</Text>
      ) : null}
    </Box>
  );
}
