import { useEffect, useState } from 'react';
import type { FileIndex } from '@vinax/core';
import { matchCommands } from './commands/registry.js';
import type { SlashCommand } from './commands/types.js';
import type { EditorState } from './editor.js';

export interface Completion {
  label: string;
  description?: string | undefined;
  /** Range of the prompt the completion replaces. */
  start: number;
  end: number;
  text: string;
  /** Slash commands without required arguments run straight away on Enter. */
  runOnEnter: boolean;
  /** What the item is, for its marker in the menu. */
  kind?: 'command' | 'file' | 'folder';
  /** Set on file items when there are more matches than shown (keep typing to narrow). */
  partial?: boolean;
}

/** How many `@` file suggestions the menu shows. */
export const FILE_SUGGESTIONS = 10;

interface Token {
  kind: 'slash' | 'file';
  query: string;
  start: number;
  end: number;
}

/** The token being completed at the cursor: `/cmd` at the very start, or an `@path` anywhere. */
export function completionToken(e: EditorState): Token | undefined {
  const before = e.value.slice(0, e.cursor);
  const slash = /^\/([\w:-]*)$/.exec(before);
  if (slash) return { kind: 'slash', query: slash[1] ?? '', start: 0, end: e.cursor };
  const at = /(^|\s)@([^\s]*)$/.exec(before);
  if (at) {
    const query = at[2] ?? '';
    return { kind: 'file', query, start: e.cursor - query.length - 1, end: e.cursor };
  }
  return undefined;
}

/** Completion menu state for the prompt; Esc dismisses it until the token changes. */
export function useSuggestions(
  editor: EditorState,
  commands: readonly SlashCommand[],
  files: FileIndex,
) {
  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState<string | undefined>(undefined);
  const [fileHits, setFileHits] = useState<{
    query: string;
    entries: { path: string; dir: boolean }[];
    more: boolean;
  }>({ query: '\u0000', entries: [], more: false });
  const token = completionToken(editor);
  const tokenKey =
    token === undefined ? undefined : `${token.kind}:${String(token.start)}:${token.query}`;

  useEffect(() => {
    setIndex(0);
    if (token?.kind !== 'file') return;
    const state = { live: true };
    // read through a function: TypeScript would otherwise narrow the flag across awaits
    const isLive = (): boolean => state.live;
    const query = token.query;
    const run = async (): Promise<boolean> => {
      const r = await files.suggest(query, FILE_SUGGESTIONS);
      if (isLive()) setFileHits({ query, entries: r.entries, more: r.more });
      return r.more;
    };
    // answer at once from what is known, then again when the background index has finished
    void run()
      .then(async (more) => {
        if (!more || !isLive()) return;
        await files.ready();
        if (isLive()) await run();
      })
      .catch(() => {
        if (isLive()) setFileHits({ query, entries: [], more: false });
      });
    return () => {
      state.live = false;
    };
  }, [tokenKey]); // recompute when the token changes

  let items: Completion[] = [];
  if (token?.kind === 'slash') {
    items = matchCommands(commands, token.query).map((c) => ({
      label: `/${c.name}${c.argumentHint === undefined ? '' : ` ${c.argumentHint}`}`,
      description: `${c.description}${c.source === 'builtin' ? '' : ` (${c.source})`}`,
      start: token.start,
      end:
        editor.value.length > token.end && editor.value[token.end] === ' '
          ? token.end + 1
          : token.end,
      text: `/${c.name} `,
      // Enter runs commands whose arguments are all optional ("[focus]")
      runOnEnter: c.argumentHint === undefined || c.argumentHint.startsWith('['),
      kind: 'command' as const,
    }));
  } else if (token?.kind === 'file' && fileHits.query === token.query) {
    items = fileHits.entries.map((e) => ({
      label: `@${e.path}`,
      start: token.start,
      end: token.end,
      // a folder keeps the menu open so its children show next
      text: e.dir ? `@${e.path}` : `@${e.path} `,
      runOnEnter: false,
      kind: e.dir ? ('folder' as const) : ('file' as const),
      ...(fileHits.more ? { partial: true } : {}),
    }));
  }
  const visible = items.length > 0 && tokenKey !== dismissed;
  return {
    items: visible ? items : [],
    index: Math.min(index, Math.max(0, items.length - 1)),
    move: (delta: number) => {
      setIndex((i) => (items.length === 0 ? 0 : (i + delta + items.length) % items.length));
    },
    dismiss: () => {
      setDismissed(tokenKey);
    },
  };
}
