import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import type { PermissionAnswer, PermissionRequest } from '@vinax/core';
import { useTheme } from '../theme.js';
import { DiffView } from './DiffView.js';
import { LineInput } from './LineInput.js';
import { Select, type SelectItem } from './Select.js';

type Choice = 'yes' | 'edits' | 'session' | 'project' | 'no';

interface Props {
  req: PermissionRequest;
  width: number;
  onAnswer: (answer: PermissionAnswer) => void;
  /** "Yes, and auto-accept edits": switches the session to auto-accept mode. */
  onAcceptEdits: () => void;
}

function title(req: PermissionRequest): string {
  switch (req.kind) {
    case 'execute':
      return 'Run this command?';
    case 'edit':
      return req.preview?.kind === 'diff' && req.preview.created
        ? `Create ${req.label}?`
        : `Edit ${req.label}?`;
    case 'read':
      return `Read ${req.label}?`;
    default:
      return `Use ${req.tool}?`;
  }
}

export function PermissionPrompt({ req, width, onAnswer, onAcceptEdits }: Props) {
  const theme = useTheme();
  const [stage, setStage] = useState<'choose' | 'feedback'>('choose');

  useInput(
    (_input, key) => {
      if (key.escape) onAnswer({ kind: 'deny', feedback: '' });
    },
    { isActive: stage === 'choose' },
  );

  const items: SelectItem<Choice>[] = [{ label: 'Yes', value: 'yes' }];
  if (req.kind === 'edit' && req.danger === undefined) {
    items.push({
      label: 'Yes, and auto-accept edits for the rest of this session',
      value: 'edits',
    });
  }
  if (req.suggestion !== undefined && req.danger === undefined) {
    items.push(
      { label: `Yes, and don't ask again for ${req.suggestion} this session`, value: 'session' },
      { label: `Yes, and don't ask again for ${req.suggestion} in this project`, value: 'project' },
    );
  }
  items.push({ label: 'No, and tell VinaX what to do differently', value: 'no', hint: '(esc)' });

  const choose = (c: Choice): void => {
    if (c === 'yes') onAnswer({ kind: 'allow' });
    else if (c === 'edits') {
      onAcceptEdits();
      onAnswer({ kind: 'allow' });
    } else if ((c === 'session' || c === 'project') && req.suggestion !== undefined) {
      onAnswer({ kind: 'allow_rule', rule: req.suggestion, scope: c });
    } else setStage('feedback');
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={req.danger === undefined ? theme.accent : theme.warning}
      paddingX={1}
      marginTop={1}
    >
      <Text bold>{title(req)}</Text>
      {req.kind === 'execute' ? (
        <Box borderStyle="single" borderColor={theme.muted} paddingX={1} marginY={1}>
          <Text wrap="wrap">{req.label}</Text>
        </Box>
      ) : null}
      {req.preview?.kind === 'diff' ? (
        <Box marginY={1}>
          <DiffView diff={req.preview} maxLines={20} width={width - 6} />
        </Box>
      ) : null}
      {req.danger === undefined ? (
        <Text color={theme.muted}>{req.reason}</Text>
      ) : (
        <Text color={theme.warning}>⚠ This {req.danger}. VinaX always asks before doing this.</Text>
      )}
      <Box marginTop={1} flexDirection="column">
        {stage === 'choose' ? (
          <Select items={items} onSelect={choose} />
        ) : (
          <>
            <Text>What should VinaX do instead? (Enter with nothing typed just stops)</Text>
            <LineInput
              placeholder="e.g. use pnpm instead of npm"
              allowEmpty
              onSubmit={(feedback) => {
                onAnswer({ kind: 'deny', feedback });
              }}
              onCancel={() => {
                onAnswer({ kind: 'deny', feedback: '' });
              }}
            />
          </>
        )}
      </Box>
    </Box>
  );
}
