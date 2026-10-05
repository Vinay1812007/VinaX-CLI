import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import type { UserAnswer, UserQuestion } from '@vinax/core';
import { useTheme } from '../theme.js';
import { LineInput } from './LineInput.js';
import { Select } from './Select.js';

export function QuestionPrompt({
  question,
  onAnswer,
}: {
  question: UserQuestion;
  onAnswer: (answer: UserAnswer) => void;
}) {
  const theme = useTheme();
  const [typing, setTyping] = useState(question.options.length === 0);
  useInput(
    (_input, key) => {
      if (key.escape) onAnswer({ cancelled: true });
    },
    { isActive: !typing },
  );
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={1}
      marginTop={1}
    >
      <Text bold>{question.question}</Text>
      {typing ? (
        <LineInput
          placeholder="Type your answer…"
          onSubmit={(answer) => {
            onAnswer({ answer });
          }}
          onCancel={() => {
            onAnswer({ cancelled: true });
          }}
        />
      ) : (
        <Select
          items={[
            ...question.options.map((label, value) => ({ label, value })),
            { label: 'Type my own answer', value: -1 },
          ]}
          onSelect={(index) => {
            const answer = question.options[index];
            if (answer === undefined) setTyping(true);
            else onAnswer({ answer });
          }}
        />
      )}
      <Text color={theme.muted}>
        {typing ? 'Enter to send' : '↑↓ choose · Enter to send · select the last option to type'} ·
        Esc to cancel
      </Text>
    </Box>
  );
}
