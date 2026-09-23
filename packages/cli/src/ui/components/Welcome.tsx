import { Box, Text } from 'ink';
import { shortenPath } from '../format.js';
import { useTheme } from '../theme.js';

const WORDMARK = [
  ' __   ___           __  __',
  ' \\ \\ / (_)_ _  __ _ \\ \\/ /',
  "  \\ V /| | ' \\/ _` | >  < ",
  '   \\_/ |_|_||_\\__,_|/_/\\_\\',
];

interface Props {
  version: string;
  cwd: string;
  model: string;
  provider: string;
  tips: readonly string[];
  width: number;
}

export function Welcome({ version, cwd, model, provider, tips, width }: Props) {
  const theme = useTheme();
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={1}
      width={Math.min(width, 88)}
    >
      {width >= 48 ? (
        <Box flexDirection="column" marginBottom={1}>
          {WORDMARK.map((line) => (
            <Text key={line} color={theme.accent} bold>
              {line}
            </Text>
          ))}
        </Box>
      ) : (
        <Text color={theme.accent} bold>
          ◆ VinaX
        </Text>
      )}
      <Text>
        <Text bold>VinaX</Text>
        <Text color={theme.muted}> v{version} · your terminal coding assistant</Text>
      </Text>
      <Text>
        <Text color={theme.muted}>folder </Text>
        {shortenPath(cwd)}
      </Text>
      <Text>
        <Text color={theme.muted}>model </Text>
        {model}
        <Text color={theme.muted}> via {provider}</Text>
      </Text>
      {tips.length === 0 ? null : (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.muted}>Tips</Text>
          {tips.map((tip) => (
            <Text key={tip} wrap="wrap">
              <Text color={theme.accent}>› </Text>
              {tip}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
