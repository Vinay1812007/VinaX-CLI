import { Box, Text } from 'ink';
import { truncate } from '../format.js';
import { useTheme } from '../theme.js';

export interface SuggestionItem {
  label: string;
  description?: string | undefined;
}

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
  const labelWidth = Math.min(36, Math.max(...items.map((i) => i.label.length)) + 2);
  return (
    <Box flexDirection="column" paddingX={2}>
      {items.map((item, i) => (
        <Text key={item.label} wrap="truncate-end">
          <Text color={i === index ? theme.accent : undefined} bold={i === index}>
            {i === index ? '❯ ' : '  '}
            {item.label.padEnd(labelWidth)}
          </Text>
          {item.description === undefined ? (
            ''
          ) : (
            <Text color={theme.muted}>
              {truncate(item.description, Math.max(10, width - labelWidth - 6))}
            </Text>
          )}
        </Text>
      ))}
      <Text color={theme.muted}> ↑↓ choose · Tab complete · Enter accept · Esc dismiss</Text>
    </Box>
  );
}
