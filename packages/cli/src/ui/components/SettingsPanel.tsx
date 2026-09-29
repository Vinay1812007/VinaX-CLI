import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { useTheme } from '../theme.js';

/** One row of /settings: a choice cycles through options, an action runs something. */
export interface SettingRow {
  key: string;
  label: string;
  value: string;
  /** Values to cycle through with ←/→, Enter or Space (booleans use ['on', 'off']). */
  options?: readonly string[];
  /** How values are shown, when that differs from the stored value. */
  labels?: Readonly<Record<string, string>>;
  /** Shown dimmed after the value, e.g. "applies to new sessions". */
  hint?: string;
  /** Enter closes the panel and returns this row's key (e.g. opening the model picker). */
  action?: boolean;
}

interface Props {
  title: string;
  rows: readonly SettingRow[];
  /** Saves a change; may return new rows (e.g. when one setting affects another). */
  onChange: (key: string, value: string) => Promise<readonly SettingRow[] | undefined>;
  onClose: (action?: string) => void;
}

function cycle(options: readonly string[], value: string, step: number): string {
  const i = options.indexOf(value);
  return options[(i + step + options.length) % options.length] ?? value;
}

/** Claude Code-style settings: ↑/↓ choose a setting, ←/→ or Enter change it, Esc closes. */
export function SettingsPanel({ title, rows: initial, onChange, onClose }: Props) {
  const theme = useTheme();
  const [rows, setRows] = useState(initial);
  const [index, setIndex] = useState(0);
  const [saved, setSaved] = useState<string | undefined>(undefined);

  const change = (row: SettingRow, step: number): void => {
    if (!row.options) return;
    const value = cycle(row.options, row.value, step);
    setRows((rs) => rs.map((r) => (r.key === row.key ? { ...r, value } : r)));
    void onChange(row.key, value).then((next) => {
      if (next) setRows(next);
      setSaved(`${row.label}: ${row.labels?.[value] ?? value}`);
    });
  };

  useInput((input, key) => {
    const row = rows[index];
    if (key.escape || input === 'q') onClose();
    else if (key.upArrow || input === 'k') setIndex((i) => (i - 1 + rows.length) % rows.length);
    else if (key.downArrow || input === 'j') setIndex((i) => (i + 1) % rows.length);
    else if (!row) return;
    else if (key.return || input === ' ') {
      if (row.action === true) onClose(row.key);
      else change(row, 1);
    } else if (key.rightArrow || input === 'l') change(row, 1);
    else if (key.leftArrow || input === 'h') change(row, -1);
  });

  const labelWidth = Math.max(...rows.map((r) => r.label.length)) + 3;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={1}
      marginTop={1}
    >
      <Text bold>{title}</Text>
      <Box flexDirection="column" marginTop={1}>
        {rows.map((r, i) => {
          const selected = i === index;
          return (
            <Box key={r.key}>
              <Text color={selected ? theme.accent : undefined} bold={selected}>
                {selected ? '❯ ' : '  '}
                {r.label.padEnd(labelWidth)}
              </Text>
              <Text color={selected ? theme.accent : undefined}>
                {r.action === true
                  ? `${r.value} ›`
                  : r.options
                    ? `‹ ${r.labels?.[r.value] ?? r.value} ›`
                    : r.value}
              </Text>
              {r.hint === undefined ? null : (
                <Text color={theme.muted} wrap="truncate-end">
                  {'  '}
                  {r.hint}
                </Text>
              )}
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.muted}>
          {saved === undefined ? '' : `✓ Saved ${saved} · `}↑↓ choose · ←→ or Enter change · Esc
          close
        </Text>
      </Box>
    </Box>
  );
}
