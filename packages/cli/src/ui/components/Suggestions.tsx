import { Box, Text } from 'ink';
import { truncate } from '../format.js';
import { useTheme } from '../theme.js';

export interface SuggestionItem {
  label: string;
  description?: string | undefined;
  /** Files and folders get a marker; commands none. */
  kind?: 'command' | 'file' | 'folder' | undefined;
  /** There are more matches than shown. */
  partial?: boolean | undefined;
}

const MARKER = { folder: '▸', file: '·' } as const;

/** The completion list under the prompt (for `/` commands and `@` files). */
export function Suggestions({
  items,
  index,
  width,
}: {
  items: readonly SuggestionItem[];
  index: number;
  width: number;
}) {
  const theme = useTheme();
  const marked = items.some((i) => i.kind === 'file' || i.kind === 'folder');
  const labelWidth = Math.min(
    Math.max(20, Math.floor(width * 0.6)),
    Math.max(...items.map((i) => i.label.length)) + 2,
  );
  return (
    <Box flexDirection="column" paddingX={2}>
      {items.map((item, i) => {
        const selected = i === index;
        const marker =
          item.kind === 'file' || item.kind === 'folder' ? MARKER[item.kind] : undefined;
        return (
          <Text key={`${item.label}:${String(i)}`} wrap="truncate-end">
            <Text color={selected ? theme.accent : undefined} bold={selected}>
              {selected ? '❯ ' : '  '}
            </Text>
            {marked ? (
              <Text color={item.kind === 'folder' ? theme.accent : theme.muted}>
                {marker ?? ' '}{' '}
              </Text>
            ) : null}
            <Text color={selected ? theme.accent : undefined} bold={selected}>
              {truncate(item.label, labelWidth).padEnd(labelWidth)}
            </Text>
            {item.description === undefined ? (
              ''
            ) : (
              <Text color={theme.muted}>
                {truncate(item.description, Math.max(10, width - labelWidth - 8))}
              </Text>
            )}
          </Text>
        );
      })}
      {items.some((i) => i.partial === true) ? (
        <Text color={theme.muted}>{'    '}… more — keep typing to narrow</Text>
      ) : null}
      <Text color={theme.muted}> ↑↓ choose · Tab complete · Enter accept · Esc dismiss</Text>
    </Box>
  );
}
