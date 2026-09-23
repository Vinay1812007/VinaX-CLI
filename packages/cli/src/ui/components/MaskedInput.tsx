import { Text, useInput, usePaste } from 'ink';
import { useState } from 'react';
import { isPrintable } from '../keys.js';
import { useTheme } from '../theme.js';

interface Props {
  placeholder: string;
  isActive?: boolean;
  onSubmit: (value: string) => void;
  onCancel?: () => void;
}

/** Single-line input that never shows what was typed (for API keys). */
export function MaskedInput({ placeholder, isActive = true, onSubmit, onCancel }: Props) {
  const theme = useTheme();
  const [value, setValue] = useState('');

  useInput(
    (input, key) => {
      if (key.return) {
        if (value.trim() !== '') onSubmit(value.trim());
      } else if (key.escape) {
        onCancel?.();
      } else if (key.backspace || key.delete) {
        setValue((v) => v.slice(0, -1));
      } else if (key.ctrl && input === 'u') {
        setValue('');
      } else if (!key.ctrl && !key.meta && isPrintable(input)) {
        setValue((v) => v + input);
      }
    },
    { isActive },
  );
  usePaste(
    (text) => {
      setValue((v) => v + text.replace(/\s+/g, ''));
    },
    { isActive },
  );

  return value === '' ? (
    <Text color={theme.muted}>{placeholder}</Text>
  ) : (
    <Text>
      {'•'.repeat(Math.min(value.length, 48))}
      <Text color={theme.muted}> ({value.length} characters)</Text>
    </Text>
  );
}
