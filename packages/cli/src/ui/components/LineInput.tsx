import { Text, useInput, usePaste } from 'ink';
import { useState } from 'react';
import { isPrintable } from '../keys.js';
import { useTheme } from '../theme.js';

interface Props {
  placeholder: string;
  isActive?: boolean;
  /** Show dots instead of the text (API keys). */
  mask?: boolean;
  /** Allow submitting an empty value. */
  allowEmpty?: boolean;
  onSubmit: (value: string) => void;
  onCancel?: () => void;
}

/** Single-line text input; with `mask` it never shows what was typed. */
export function LineInput({
  placeholder,
  isActive = true,
  mask = false,
  allowEmpty = false,
  onSubmit,
  onCancel,
}: Props) {
  const theme = useTheme();
  const [value, setValue] = useState('');

  useInput(
    (input, key) => {
      if (key.return) {
        if (allowEmpty || value.trim() !== '') onSubmit(value.trim());
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
      setValue((v) => v + (mask ? text.replace(/\s+/g, '') : text.replace(/\s*\n\s*/g, ' ')));
    },
    { isActive },
  );

  if (value === '') {
    return (
      <Text>
        <Text inverse> </Text>
        <Text color={theme.muted}>{placeholder}</Text>
      </Text>
    );
  }
  return mask ? (
    <Text>
      {'•'.repeat(Math.min(value.length, 48))}
      <Text color={theme.muted}> ({value.length} characters)</Text>
    </Text>
  ) : (
    <Text>
      {value}
      <Text inverse> </Text>
    </Text>
  );
}
