import { Box, Text } from 'ink';
import { shortenPath } from '../format.js';
import { useTheme } from '../theme.js';
import { Select } from './Select.js';

interface Props {
  cwd: string;
  onAnswer: (trusted: boolean) => void;
}

export function TrustPrompt({ cwd, onAnswer }: Props) {
  const theme = useTheme();
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.warning} paddingX={1}>
      <Text bold color={theme.warning}>
        Do you trust the files in this folder?
      </Text>
      <Text>{shortenPath(cwd)}</Text>
      <Box marginY={1} flexDirection="column">
        <Text wrap="wrap">
          VinaX will read files here. With your approval it can also edit files and run commands in
          this folder. Instructions inside project files can influence what VinaX does, so only
          continue in folders whose contents you trust.
        </Text>
      </Box>
      <Select
        items={[
          { label: 'Yes, continue', value: true },
          { label: 'No, exit', value: false },
        ]}
        onSelect={onAnswer}
      />
      <Text color={theme.muted}>
        Your answer is remembered for this folder and the folders inside it.
      </Text>
    </Box>
  );
}
