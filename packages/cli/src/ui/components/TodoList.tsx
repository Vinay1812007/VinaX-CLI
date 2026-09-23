import { Box, Text } from 'ink';
import type { TodoItem } from '@vinax/core';
import { useTheme } from '../theme.js';

/** The model's task list: ☐ pending, ◐ in progress, ☑ done. */
export function TodoList({ todos }: { todos: readonly TodoItem[] }) {
  const theme = useTheme();
  return (
    <Box flexDirection="column">
      {todos.map((t, i) => {
        if (t.status === 'completed') {
          return (
            <Text key={i} color={theme.muted} strikethrough>
              ☑ {t.content}
            </Text>
          );
        }
        if (t.status === 'in_progress') {
          return (
            <Text key={i} color={theme.accent} bold>
              ◐ {t.activeForm ?? t.content}
            </Text>
          );
        }
        return <Text key={i}>☐ {t.content}</Text>;
      })}
    </Box>
  );
}
