import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { useTheme } from '../theme.js';

export interface SelectItem<T> {
  label: string;
  value: T;
  hint?: string;
  /** Heading the item is listed under (searchable pickers group consecutive items). */
  group?: string;
  /** Marks the active choice (e.g. the current model) with ●. */
  current?: boolean;
  /** Shown dimmed and cannot be chosen; `hint` should say why. */
  disabled?: boolean;
  /** Extra words the search matches (aliases, provider names). */
  keywords?: readonly string[];
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
  const choose = (position: number): void => {
    const item = items[position];
    if (item && !item.disabled) onSelect(item.value);
  };

  const move = (next: number): void => {
    if (items.length === 0) return;
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
        choose(index);
      } else if (/^[1-9]$/.test(input)) {
        choose(Number(input) - 1);
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
            {/* the label keeps its width; a long hint is cut instead */}
            <Box flexShrink={0}>
              <Text
                color={item.disabled ? theme.muted : selected ? theme.accent : undefined}
                bold={selected && !item.disabled}
              >
                {selected ? '❯ ' : '  '}
                {i + 1}. {item.label}
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
      {first + shown.length < items.length ? (
        <Text color={theme.muted}> ↓ {items.length - first - shown.length} more</Text>
      ) : null}
    </Box>
  );
}
