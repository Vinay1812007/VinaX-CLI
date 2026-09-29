import path from 'node:path';
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import type { Env, MemoryFile } from '@vinax/core';
import {
  asciiOnly,
  bandFor,
  BRAND_COLORS,
  LOGO_GRID,
  LOGO_MIN_WIDTH,
  logoSegments,
  TAGLINE,
} from '../brand.js';
import { shortenPath, truncate } from '../format.js';
import { useTheme, type Theme } from '../theme.js';

interface Props {
  version: string;
  cwd: string;
  model: string;
  provider: string;
  /** Short name of the model, e.g. NVD_CHAT_OSS_20_B. */
  alias?: string | undefined;
  branch?: string | undefined;
  /** "new session" or the title of the resumed conversation. */
  session?: string | undefined;
  memory?: readonly MemoryFile[];
  tips: readonly string[];
  width: number;
  env?: Env;
}

const SHORTCUTS: readonly [string, string][] = [
  ['/', 'commands'],
  ['@', 'files'],
  ['!', 'shell'],
  ['#', 'memory'],
  ['?', 'shortcuts'],
];

/** Memory files by their display name, without paths or content (nothing sensitive). */
export function memoryLabels(files: readonly MemoryFile[], cwd: string): string[] {
  const labels = files.map((f) => {
    const name = path.basename(f.path);
    if (f.scope === 'user') return `${name} (personal)`;
    const rel = path.relative(cwd, f.path);
    return rel.startsWith('..') || path.isAbsolute(rel) ? name : rel.split(path.sep).join('/');
  });
  const imports = files.reduce((n, f) => n + (f.imports?.length ?? 0), 0);
  if (imports > 0) labels.push(`${String(imports)} imported file${imports === 1 ? '' : 's'}`);
  return labels;
}

function bandColor(row: number, theme: Theme): string | undefined {
  if (!theme.color) return undefined;
  const band = bandFor(row);
  if (band === 'white')
    return theme.name === 'light' ? BRAND_COLORS.whiteOnLight : BRAND_COLORS.white;
  return BRAND_COLORS[band];
}

/** The striped tricolor VinaX logo (see brand.ts); plain shapes under NO_COLOR. */
export function Logo({ env = {} }: { env?: Env }) {
  const theme = useTheme();
  const ascii = asciiOnly(env);
  return (
    <Box flexDirection="column">
      {LOGO_GRID.map((row, i) => (
        <Text key={i}>
          {logoSegments(row, ascii).map((seg, j) => (
            <Text
              key={j}
              color={
                seg.kind === 'chakra'
                  ? theme.color
                    ? BRAND_COLORS.chakra
                    : undefined
                  : bandColor(i, theme)
              }
              bold={seg.kind === 'chakra'}
            >
              {seg.text}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  );
}

/** One-line tricolor name for narrow terminals. */
function SmallName() {
  const theme = useTheme();
  return (
    <Text bold>
      <Text color={bandColor(0, theme)}>Vi</Text>
      <Text color={bandColor(3, theme)}>na</Text>
      <Text color={bandColor(6, theme)}>X</Text>
    </Text>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  const theme = useTheme();
  return (
    <Box>
      <Box width={9} flexShrink={0}>
        <Text color={theme.muted}>{label}</Text>
      </Box>
      <Box flexGrow={1}>
        <Text wrap="truncate-end">{children}</Text>
      </Box>
    </Box>
  );
}

export function Welcome({
  version,
  cwd,
  model,
  provider,
  alias,
  branch,
  session,
  memory = [],
  tips,
  width,
  env = {},
}: Props) {
  const theme = useTheme();
  const boxWidth = Math.min(width, 88);
  const inner = boxWidth - 4;
  const wide = boxWidth >= LOGO_MIN_WIDTH;
  const memoryShown = memoryLabels(memory, cwd);
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={1}
      width={boxWidth}
    >
      {wide ? (
        <Box flexDirection="column">
          <Logo env={env} />
          <Text wrap="truncate-end">
            <Text bold>VinaX</Text>
            <Text color={theme.muted}>
              {' '}
              v{version} · {TAGLINE}
            </Text>
          </Text>
        </Box>
      ) : (
        <Text>
          <SmallName />
          <Text color={theme.muted}> v{version}</Text>
        </Text>
      )}
      <Box flexDirection="column" marginTop={1}>
        <Row label="cwd">
          {truncate(shortenPath(cwd), Math.max(10, inner - 9 - (branch ? branch.length + 4 : 0)))}
          {branch === undefined ? '' : <Text color={theme.muted}> ⎇ {branch}</Text>}
        </Row>
        <Row label="model">
          {model}
          <Text color={theme.muted}>
            {' '}
            · {provider}
            {alias === undefined ? '' : ` · ${alias}`}
          </Text>
        </Row>
        {session === undefined ? null : <Row label="session">{session}</Row>}
        {memoryShown.length === 0 ? null : (
          <Row label="memory">
            {memoryShown.map((m, i) => (
              <Text key={m}>
                {i === 0 ? '' : '  '}
                <Text color={theme.success}>✓</Text> {m}
              </Text>
            ))}
          </Row>
        )}
      </Box>
      {wide ? (
        <Box marginTop={1} flexWrap="wrap">
          {SHORTCUTS.map(([key, what]) => (
            <Box key={key} marginRight={2}>
              <Text>
                <Text color={theme.accent} bold>
                  {key}
                </Text>
                <Text color={theme.muted}> {what}</Text>
              </Text>
            </Box>
          ))}
        </Box>
      ) : null}
      {tips.length === 0 ? null : (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.muted}>Tips</Text>
          {tips.map((tip) => (
            <Text key={tip} wrap="wrap">
              <Text color={theme.accent}>› </Text>
              {tip}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
