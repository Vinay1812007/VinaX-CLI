import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import { padColumns } from '../format.js';
import { useTheme } from '../theme.js';

const SHORTCUTS: readonly [string, string][] = [
  ['Enter', 'send'],
  ['\\ then Enter · Shift+Enter · Option/Alt+Enter', 'new line'],
  ['↑ / ↓', 'move between lines, then through prompt history'],
  ['Ctrl+R', 'search prompt history'],
  ['Shift+Tab', 'cycle ⏸ manual → ⏵⏵ accept edits → ⏸ plan → ⏵⏵ auto'],
  ['Esc', 'stop the current response'],
  ['Esc Esc', 'clear the prompt; on an empty prompt, rewind'],
  ['Ctrl+V', 'paste an image from the clipboard (drag a file in, or @file.png)'],
  ['Option/Alt+← →  · Ctrl+A / Ctrl+E', 'word left / right · start / end of line'],
  ['Option/Alt+Backspace · Ctrl+W · Alt+D', 'delete word before · before · after'],
  ['Ctrl+U · Ctrl+K · Ctrl+Y', 'delete to line start · to line end · paste it back'],
  ['Ctrl+_', 'undo'],
  ['Ctrl+P', 'command palette: search every command and view'],
  ['Ctrl+G', 'review changed files: diffs, undo one file'],
  ['Ctrl+O', 'transcript: search, full tool output, models, tokens, rate limits'],
  ['Ctrl+L', 'redraw the screen'],
  ['Mouse / trackpad', 'select text to copy it; /copy copies the last answer'],
  ['Ctrl+C', 'clear the prompt; press twice to exit'],
  ['Ctrl+D', 'exit (on an empty prompt)'],
];

export function ShortcutsHelp() {
  const theme = useTheme();
  const keyWidth = Math.max(...SHORTCUTS.map(([k]) => stringWidth(k))) + 2;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.muted} paddingX={1}>
      <Text bold>Keyboard shortcuts</Text>
      {SHORTCUTS.map(([keys, action]) => (
        <Text key={keys}>
          <Text color={theme.accent}>{padColumns(keys, keyWidth)}</Text>
          {action}
        </Text>
      ))}
      <Text color={theme.muted}>Press any key to close</Text>
    </Box>
  );
}
