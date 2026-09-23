import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';

const SHORTCUTS: readonly [string, string][] = [
  ['Enter', 'send'],
  ['\\ then Enter · Shift+Enter · Option/Alt+Enter', 'new line'],
  ['↑ / ↓', 'move between lines, then through prompt history'],
  ['Ctrl+R', 'search prompt history'],
  ['Esc', 'stop the current response'],
  ['Esc Esc', 'clear the prompt; on an empty prompt, rewind'],
  ['Shift+Tab', 'cycle default → auto-accept edits → plan mode'],
  ['Ctrl+O', 'turn details: tools, models, tokens, rate limits'],
  ['Ctrl+A / Ctrl+E', 'start / end of line'],
  ['Ctrl+W · Ctrl+U · Ctrl+K', 'delete word · to line start · to line end'],
  ['Ctrl+C', 'clear the prompt; press twice to exit'],
  ['Ctrl+D', 'exit (on an empty prompt)'],
];

export function ShortcutsHelp() {
  const theme = useTheme();
  const keyWidth = Math.max(...SHORTCUTS.map(([k]) => k.length)) + 2;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.muted} paddingX={1}>
      <Text bold>Keyboard shortcuts</Text>
      {SHORTCUTS.map(([keys, action]) => (
        <Text key={keys}>
          <Text color={theme.accent}>{keys.padEnd(keyWidth)}</Text>
          {action}
        </Text>
      ))}
      <Text color={theme.muted}>Press any key to close</Text>
    </Box>
  );
}
