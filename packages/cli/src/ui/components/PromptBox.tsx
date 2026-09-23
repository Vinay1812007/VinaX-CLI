import { Box, Text } from 'ink';
import type { EditorState } from '../editor.js';
import { useTheme } from '../theme.js';

export interface SearchView {
  query: string;
  match: string | undefined;
}

interface Props {
  editor: EditorState;
  placeholder: string;
  search: SearchView | undefined;
  dimmed: boolean;
  /** Shown above the text, e.g. "shell command" or "-- NORMAL --". */
  label?: string | undefined;
  /** Border colour override for special input modes. */
  tone?: 'shell' | 'memory' | undefined;
}

/** Renders the text with the cursor cell shown in inverse video. */
function Lines({ editor }: { editor: EditorState }) {
  const theme = useTheme();
  const lines = editor.value.split('\n');
  let offset = 0;
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        const start = offset;
        offset += line.length + 1;
        const prefix = <Text color={theme.accent}>{i === 0 ? '› ' : '  '}</Text>;
        const col = editor.cursor - start;
        if (col < 0 || col > line.length) {
          return (
            <Text key={i}>
              {prefix}
              {line === '' ? ' ' : line}
            </Text>
          );
        }
        return (
          <Text key={i}>
            {prefix}
            {line.slice(0, col)}
            <Text inverse>{line[col] ?? ' '}</Text>
            {line.slice(col + 1)}
          </Text>
        );
      })}
    </Box>
  );
}

export function PromptBox({ editor, placeholder, search, dimmed, label, tone }: Props) {
  const theme = useTheme();
  const border =
    tone === 'shell'
      ? theme.warning
      : tone === 'memory'
        ? theme.success
        : dimmed
          ? theme.muted
          : theme.accent;
  return (
    <Box borderStyle="round" borderColor={border} paddingX={1} flexDirection="column">
      {label === undefined ? null : <Text color={border}>{label}</Text>}
      {search !== undefined ? (
        <Text>
          <Text color={theme.accent}>search history: </Text>
          {search.query}
          <Text inverse> </Text>
          <Text color={theme.muted}>
            {search.match === undefined
              ? '  (no match)'
              : `  → ${search.match.split('\n')[0] ?? ''}`}
          </Text>
        </Text>
      ) : editor.value === '' ? (
        <Text>
          <Text color={theme.accent}>› </Text>
          <Text inverse> </Text>
          <Text color={theme.muted}>{placeholder}</Text>
        </Text>
      ) : (
        <Lines editor={editor} />
      )}
    </Box>
  );
}
