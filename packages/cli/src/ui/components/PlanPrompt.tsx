import { Box, Text, useInput, useWindowSize } from 'ink';
import { useMemo, useState } from 'react';
import type { PlanDecision } from '@vinax/core';
import { renderMarkdown } from '../markdown.js';
import { useTheme } from '../theme.js';
import { LineInput } from './LineInput.js';
import { Select } from './Select.js';

type Choice = 'accept' | 'ask' | 'revise' | 'auto';

export function PlanPrompt({
  plan,
  width,
  onDecide,
}: {
  plan: string;
  width: number;
  onDecide: (d: PlanDecision) => void;
}) {
  const theme = useTheme();
  const { rows } = useWindowSize();
  const pageSize = Math.max(3, rows - 16);
  const lines = useMemo(
    () => renderMarkdown(plan, { width: width - 4, theme }).split('\n'),
    [plan, width, theme],
  );
  const [offset, setOffset] = useState(0);
  const first = Math.min(offset, Math.max(0, lines.length - pageSize));
  const [stage, setStage] = useState<'choose' | 'feedback'>('choose');
  useInput(
    (_input, key) => {
      if (key.escape) onDecide({ approved: false, feedback: '' });
      else if (key.pageDown)
        setOffset(Math.min(first + pageSize, Math.max(0, lines.length - pageSize)));
      else if (key.pageUp) setOffset(Math.max(0, first - pageSize));
    },
    { isActive: stage === 'choose' },
  );
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={1}
      marginTop={1}
    >
      <Text bold color={theme.accent}>
        VinaX&apos;s plan
      </Text>
      <Box marginY={1}>
        <Text>{lines.slice(first, first + pageSize).join('\n')}</Text>
      </Box>
      {lines.length > pageSize ? (
        <Text color={theme.muted}>
          PgUp/PgDn to read the plan · lines {first + 1}–{Math.min(first + pageSize, lines.length)}{' '}
          of {lines.length}
        </Text>
      ) : null}
      <Text bold>Go ahead with this plan?</Text>
      {stage === 'choose' ? (
        <Select<Choice>
          items={[
            { label: 'Yes, and auto-accept edits', value: 'accept' },
            { label: 'Yes, and ask before each edit', value: 'ask' },
            { label: 'No, keep planning — tell VinaX what to change', value: 'revise' },
            { label: 'Yes, use auto mode for edits and commands', value: 'auto' },
          ]}
          onSelect={(c) => {
            if (c === 'accept') onDecide({ approved: true, mode: 'acceptEdits' });
            else if (c === 'ask') onDecide({ approved: true, mode: 'default' });
            else if (c === 'auto') onDecide({ approved: true, mode: 'auto' });
            else setStage('feedback');
          }}
        />
      ) : (
        <LineInput
          placeholder="What should change in the plan?"
          allowEmpty
          onSubmit={(feedback) => {
            onDecide({ approved: false, feedback });
          }}
          onCancel={() => {
            onDecide({ approved: false, feedback: '' });
          }}
        />
      )}
      <Text color={theme.muted}>Enter to choose · Esc to cancel</Text>
    </Box>
  );
}
