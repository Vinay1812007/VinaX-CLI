import { Box, Text } from 'ink';
import type { EditorState } from '../editor.js';
import { useTheme, type Theme } from '../theme.js';

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

/** The prompt glyph: `!` for shell commands, `#` for memory notes, `>` otherwise. */
function glyphFor(tone: Props['tone']): string {
  return tone === 'shell' ? '!' : tone === 'memory' ? '#' : '>';
}

/** Border colour per input mode; plain prompts use a quiet grey border like Claude Code. */
function borderFor(tone: Props['tone'], theme: Theme): string | undefined {
  if (!theme.color) return undefined;
  if (tone === 'shell') return theme.name === 'light' ? '#DB2777' : '#F472B6';
  if (tone === 'memory') return theme.name === 'light' ? '#2563EB' : '#60A5FA';
  return theme.muted;
}

/** Renders the text with the cursor cell shown in inverse video. */
function Lines({ editor, tone }: { editor: EditorState; tone: Props['tone'] }) {
  const theme = useTheme();
  const glyph = glyphFor(tone);
  const glyphColor = tone === undefined ? theme.accent : borderFor(tone, theme);
  const lines = editor.value.split('\n');
  let offset = 0;
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        const start = offset;
        offset += line.length + 1;
        const prefix = <Text color={glyphColor}>{i === 0 ? `${glyph} ` : '  '}</Text>;
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
  const border = borderFor(tone, theme);
  const glyphColor = tone === undefined ? (dimmed ? theme.muted : theme.accent) : border;
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
        <Text wrap="truncate-end">
          <Text color={glyphColor}>{glyphFor(tone)} </Text>
          <Text inverse> </Text>
          <Text color={theme.muted}>{placeholder}</Text>
        </Text>
      ) : (
        <Lines editor={editor} tone={tone} />
      )}
    </Box>
  );
}
