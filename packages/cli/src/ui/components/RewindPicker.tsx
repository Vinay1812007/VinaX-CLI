import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { truncate } from '../format.js';
import { useTheme } from '../theme.js';
import { Select } from './Select.js';

export interface RewindTarget {
  turn: number;
  prompt: string;
  /** Files VinaX changed from this turn on (restorable). */
  changedFiles: number;
}

export interface RewindChoice {
  turn: number;
  conversation: boolean;
  code: boolean;
}

type Action = 'both' | 'conversation' | 'code' | 'cancel';

/** Esc Esc: pick an earlier prompt, then what to restore. */
export function RewindPicker({
  targets,
  width,
  onDone,
}: {
  targets: readonly RewindTarget[];
  width: number;
  onDone: (choice: RewindChoice | undefined) => void;
}) {
  const theme = useTheme();
  const [picked, setPicked] = useState<RewindTarget | undefined>(undefined);
  useInput((_input, key) => {
    if (key.escape) onDone(undefined);
  });
  const newestFirst = [...targets].reverse();
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={1}
      marginTop={1}
    >
      {picked === undefined ? (
        <>
          <Text bold>Rewind to before which prompt?</Text>
          <Text color={theme.muted}>
            The conversation and/or files go back to how they were before it. Esc to cancel.
          </Text>
          <Box marginTop={1}>
            <Select
              items={newestFirst.map((t) => ({
                label: truncate(t.prompt, width - 30),
                value: t,
                hint:
                  t.changedFiles === 0
                    ? ''
                    : `${String(t.changedFiles)} file${t.changedFiles === 1 ? '' : 's'} changed since`,
              }))}
              onSelect={setPicked}
            />
          </Box>
        </>
      ) : (
        <>
          <Text bold>Rewind to before “{truncate(picked.prompt, width - 30)}”</Text>
          <Box marginTop={1}>
            <Select<Action>
              items={[
                ...(picked.changedFiles > 0
                  ? [
                      {
                        label: `Restore the conversation and ${String(picked.changedFiles)} changed file(s)`,
                        value: 'both' as const,
                      },
                    ]
                  : []),
                { label: 'Restore the conversation only', value: 'conversation' },
                ...(picked.changedFiles > 0
                  ? [{ label: 'Restore the files only', value: 'code' as const }]
                  : []),
                { label: 'Cancel', value: 'cancel' },
              ]}
              onSelect={(a) => {
                if (a === 'cancel') onDone(undefined);
                else
                  onDone({
                    turn: picked.turn,
                    conversation: a !== 'code',
                    code: a !== 'conversation',
                  });
              }}
            />
          </Box>
          <Text color={theme.muted}>
            Only changes made with VinaX&apos;s file tools can be restored, not changes made by
            commands.
          </Text>
        </>
      )}
    </Box>
  );
}
