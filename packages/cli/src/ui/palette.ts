import type { SlashCommand } from './commands/types.js';
import type { SelectItem } from './components/Select.js';

/** Something the palette can do that is not a slash command (opening a view). */
export interface PaletteAction {
  id: string;
  label: string;
  description: string;
  /** The shortcut that does the same, shown so the palette also teaches the keys. */
  keys?: string;
}

export type PaletteChoice =
  | { kind: 'action'; id: string }
  /** `needsArgs`: the command takes a required argument, so it goes into the prompt instead. */
  | { kind: 'command'; name: string; needsArgs: boolean };

/** Views and controls of the chat screen, in the order they are listed. */
export const PALETTE_ACTIONS: readonly PaletteAction[] = [
  {
    id: 'changes',
    label: 'Review changes',
    description: 'files VinaX changed this session, diffs, undo per file',
    keys: 'Ctrl+G',
  },
  {
    id: 'transcript',
    label: 'Search transcript',
    description: 'every prompt, answer and tool call, with full output',
    keys: 'Ctrl+O',
  },
  {
    id: 'rewind',
    label: 'Rewind',
    description: 'go back to before an earlier prompt',
    keys: 'Esc Esc',
  },
  {
    id: 'mode',
    label: 'Next permission mode',
    description: 'manual → accept edits → plan → auto',
    keys: 'Shift+Tab',
  },
  { id: 'shortcuts', label: 'Keyboard shortcuts', description: 'every key binding', keys: '?' },
];

/**
 * Palette items: actions first, then every slash command (built-in and custom) from the same
 * registry the `/` menu uses, so the two never disagree.
 */
export function paletteItems(
  commands: readonly SlashCommand[],
  actions: readonly PaletteAction[] = PALETTE_ACTIONS,
): SelectItem<PaletteChoice>[] {
  return [
    ...actions.map((a) => ({
      label: a.label,
      value: { kind: 'action' as const, id: a.id },
      hint: a.keys === undefined ? a.description : `${a.keys} · ${a.description}`,
      group: 'Views',
      keywords: [a.id],
    })),
    ...commands.map((c) => ({
      label: `/${c.name}${c.argumentHint === undefined ? '' : ` ${c.argumentHint}`}`,
      value: {
        kind: 'command' as const,
        name: c.name,
        needsArgs: c.argumentHint?.trim().startsWith('<') === true,
      },
      hint: `${c.description}${c.source === 'builtin' ? '' : ` (${c.source})`}`,
      group: 'Commands',
      keywords: [c.name, ...(c.aliases ?? [])],
    })),
  ];
}
