import { Box, Text } from 'ink';
import { useState } from 'react';
import type { PlanDecision } from '@vinax/core';
import { renderMarkdown } from '../markdown.js';
import { useTheme } from '../theme.js';
import { LineInput } from './LineInput.js';
import { Select } from './Select.js';

type Choice = 'accept' | 'ask' | 'revise';

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
  const [stage, setStage] = useState<'choose' | 'feedback'>('choose');
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
        <Text>{renderMarkdown(plan, { width: width - 4, theme })}</Text>
      </Box>
      <Text bold>Go ahead with this plan?</Text>
      {stage === 'choose' ? (
        <Select<Choice>
          items={[
            { label: 'Yes, and auto-accept edits', value: 'accept' },
            { label: 'Yes, and ask before each edit', value: 'ask' },
            { label: 'No, keep planning — tell VinaX what to change', value: 'revise' },
          ]}
          onSelect={(c) => {
            if (c === 'accept') onDecide({ approved: true, mode: 'acceptEdits' });
            else if (c === 'ask') onDecide({ approved: true, mode: 'default' });
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
    </Box>
  );
}
