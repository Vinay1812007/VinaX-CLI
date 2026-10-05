import { Box, Text, useInput } from 'ink';
import { useMemo, useState } from 'react';
import type { RateLimitSnapshot } from '@vinax/core';
import { formatTokens, truncate } from '../format.js';
import { isPrintable } from '../keys.js';
import { useTheme } from '../theme.js';
import { matchLine, searchEntries, type BrowseEntry } from '../transcript-browser.js';

const GLYPH: Record<BrowseEntry['kind'], string> = {
  prompt: '›',
  answer: '•',
  tool: '▸',
  shell: '!',
  notice: '·',
  error: '✖',
  panel: '▤',
};

function limitLine(key: string, s: RateLimitSnapshot): string {
  const parts: string[] = [];
  if (s.tokens.remaining !== undefined && s.tokens.limit !== undefined) {
    parts.push(
      `${formatTokens(s.tokens.remaining)}/${formatTokens(s.tokens.limit)} tokens/min left`,
    );
  }
  if (s.requests.remaining !== undefined && s.requests.limit !== undefined) {
    parts.push(`${s.requests.remaining}/${s.requests.limit} requests left`);
  }
  return `${key}: ${parts.length === 0 ? 'no limit headers yet' : parts.join(', ')}`;
}

interface Props {
  entries: readonly BrowseEntry[];
  limits: readonly [string, RateLimitSnapshot][];
  width: number;
  height: number;
  onClose: () => void;
}

/**
 * Ctrl+O: the whole transcript as a list (newest selected), with each prompt's model, timing,
 * tokens and fallbacks. `/` searches prompts, answers and full tool output; Enter expands an
 * entry to read all of it. The terminal's own scrollback is left as it is.
 */
export function TranscriptBrowser({ entries, limits, width, height, onClose }: Props) {
  const theme = useTheme();
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const shown = useMemo(() => searchEntries(entries, query), [entries, query]);
  const [cursor, setCursor] = useState<number | undefined>(undefined);
  const index = Math.min(cursor ?? shown.length - 1, shown.length - 1);
  const [expanded, setExpanded] = useState<string | undefined>(undefined);
  const [scroll, setScroll] = useState(0);
  const selected = index >= 0 ? shown[index] : undefined;
  const open = expanded !== undefined && selected?.key === expanded ? selected : undefined;

  const limitRows = open === undefined && limits.length > 0 ? limits.length + 2 : 0;
  const listRows = Math.max(3, height - 9 - limitRows);
  const bodyLines = open === undefined ? [] : open.body.split('\n');
  const bodyRows = Math.max(3, height - 10);

  useInput((input, key) => {
    if (searching) {
      if (key.escape) {
        setSearching(false);
        setQuery('');
        setCursor(undefined);
      } else if (key.return) setSearching(false);
      else if (key.backspace || key.delete) {
        setQuery((q) => q.slice(0, -1));
        setCursor(undefined);
      } else if (key.ctrl && input === 'u') setQuery('');
      else if (!key.ctrl && !key.meta && isPrintable(input)) {
        setQuery((q) => q + input);
        setCursor(undefined);
      }
      return;
    }
    if (key.ctrl && input === 'o') {
      onClose();
      return;
    }
    if (open !== undefined) {
      if (key.escape || key.return || key.leftArrow) setExpanded(undefined);
      else if (key.upArrow || input === 'k') setScroll((s) => Math.max(0, s - 1));
      else if (key.downArrow || input === 'j')
        setScroll((s) => Math.min(Math.max(0, bodyLines.length - bodyRows), s + 1));
      else if (key.pageDown || input === ' ')
        setScroll((s) => Math.min(Math.max(0, bodyLines.length - bodyRows), s + bodyRows));
      else if (key.pageUp || input === 'b') setScroll((s) => Math.max(0, s - bodyRows));
      return;
    }
    if (key.escape) {
      if (query !== '') {
        setQuery('');
        setCursor(undefined);
      } else onClose();
    } else if (input === '/') {
      setSearching(true);
    } else if ((key.upArrow || input === 'k') && shown.length > 0) {
      setCursor(Math.max(0, index - 1));
    } else if ((key.downArrow || input === 'j') && shown.length > 0) {
      setCursor(Math.min(shown.length - 1, index + 1));
    } else if (key.pageUp) setCursor(Math.max(0, index - listRows));
    else if (key.pageDown) setCursor(Math.min(shown.length - 1, index + listRows));
    else if ((key.return || key.rightArrow) && selected !== undefined) {
      setExpanded(selected.key);
      setScroll(0);
    }
  });

  const color = (e: BrowseEntry): string | undefined =>
    e.tone === 'error'
      ? theme.error
      : e.tone === 'warning'
        ? theme.warning
        : e.tone === 'muted'
          ? theme.muted
          : undefined;

  const first = Math.min(
    Math.max(0, index - Math.floor(listRows / 2)),
    Math.max(0, shown.length - listRows),
  );
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.muted} paddingX={1}>
      <Text bold wrap="truncate-end">
        Turn details &amp; transcript{' '}
        <Text color={theme.muted}>
          {open === undefined
            ? '(↑↓ move · Enter expand · / search · Esc or Ctrl+O close)'
            : '(↑↓ PgUp/PgDn scroll · Enter or Esc back)'}
        </Text>
      </Text>
      {searching || query !== '' ? (
        <Text>
          <Text color={theme.accent}>⌕ </Text>
          {query === '' ? <Text color={theme.muted}>type to search</Text> : query}
          {searching ? <Text color={theme.accent}>▏</Text> : null}
          <Text color={theme.muted}>
            {' '}
            · {shown.length} of {entries.length}
            {searching ? ' · Enter to browse results · Esc clears' : ' · Esc clears'}
          </Text>
        </Text>
      ) : null}
      {entries.length === 0 ? (
        <Text color={theme.muted}>Nothing here yet: send a prompt and it shows up here.</Text>
      ) : shown.length === 0 ? (
        <Text color={theme.muted}>No matches for “{query}”. Esc clears the search.</Text>
      ) : null}
      {open !== undefined ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={color(open)} wrap="truncate-end">
            {GLYPH[open.kind]} {truncate(open.title, width - 6)}
          </Text>
          {open.meta === undefined ? null : (
            <Text color={theme.muted} wrap="truncate-end">
              {'  '}
              {open.meta}
            </Text>
          )}
          {scroll > 0 ? <Text color={theme.muted}> ↑ {scroll} lines above</Text> : null}
          {bodyLines.slice(scroll, scroll + bodyRows).map((line, i) => (
            <Text key={i} wrap="truncate-end">
              {'  '}
              {line.replace(/\t/g, '  ')}
            </Text>
          ))}
          {scroll + bodyRows < bodyLines.length ? (
            <Text color={theme.muted}> … {bodyLines.length - scroll - bodyRows} more lines</Text>
          ) : null}
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={shown.length === 0 ? 0 : 1}>
          {first > 0 ? <Text color={theme.muted}> ↑ {first} earlier</Text> : null}
          {shown.slice(first, first + listRows).map((e, i) => {
            const active = first + i === index;
            const hit = matchLine(e, query);
            return (
              <Box key={e.key} flexDirection="column">
                <Text wrap="truncate-end">
                  <Text color={active ? theme.accent : theme.muted}>{active ? '❯ ' : '  '}</Text>
                  <Text color={color(e)} bold={active || e.kind === 'prompt'}>
                    {GLYPH[e.kind]} {truncate(e.title, width - 8)}
                  </Text>
                </Text>
                {e.meta !== undefined ? (
                  <Text color={theme.muted} wrap="truncate-end">
                    {'     '}
                    {e.meta}
                  </Text>
                ) : null}
                {hit === undefined ? null : (
                  <Text color={theme.muted} wrap="truncate-end">
                    {'     … '}
                    {truncate(hit, width - 12)}
                  </Text>
                )}
              </Box>
            );
          })}
          {first + listRows < shown.length ? (
            <Text color={theme.muted}> ↓ {shown.length - first - listRows} later</Text>
          ) : null}
        </Box>
      )}
      {limitRows === 0 ? null : (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.muted}>Rate limits</Text>
          {limits.map(([key, snap]) => (
            <Text key={key} color={theme.muted} wrap="truncate-end">
              {'  '}
              {limitLine(key, snap)}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
