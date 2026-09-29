import { Box, Text, useInput, useWindowSize } from 'ink';
import { useTheme } from '../theme.js';
import { FilterSelect } from './FilterSelect.js';
import { LineInput } from './LineInput.js';
import { Select, type SelectItem } from './Select.js';

/** A titled list to choose from; Esc cancels. `searchable` adds type-to-filter and groups. */
export function PickerOverlay<T>({
  title,
  items,
  searchable = false,
  onDone,
}: {
  title: string;
  items: readonly SelectItem<T>[];
  searchable?: boolean;
  onDone: (value: T | undefined) => void;
}) {
  const theme = useTheme();
  const { columns } = useWindowSize();
  useInput((_i, key) => {
    if (key.escape) onDone(undefined);
  });
  if (searchable) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.accent}
        paddingX={1}
        marginTop={1}
      >
        <Text bold>{title}</Text>
        <Box marginTop={1}>
          <FilterSelect items={items} onSelect={onDone} width={Math.max(20, columns - 4)} />
        </Box>
        <Text color={theme.muted}>Type to search · ↑↓ move · Enter to choose · Esc to cancel</Text>
      </Box>
    );
  }
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={1}
      marginTop={1}
    >
      <Text bold>{title}</Text>
      <Box marginTop={1}>
        <Select items={items} onSelect={onDone} />
      </Box>
      <Text color={theme.muted}>Enter to choose · Esc to cancel</Text>
    </Box>
  );
}

/** A one-line question (optionally masked, for keys); Esc cancels. */
export function AskOverlay({
  title,
  placeholder,
  mask,
  onDone,
}: {
  title: string;
  placeholder: string;
  mask: boolean;
  onDone: (value: string | undefined) => void;
}) {
  const theme = useTheme();
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={1}
      marginTop={1}
    >
      <Text bold>{title}</Text>
      <LineInput
        placeholder={placeholder}
        mask={mask}
        onSubmit={onDone}
        onCancel={() => {
          onDone(undefined);
        }}
      />
      <Text color={theme.muted}>Enter to confirm · Esc to cancel</Text>
    </Box>
  );
}
