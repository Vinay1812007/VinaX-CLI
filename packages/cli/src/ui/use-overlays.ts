import type { RefObject } from 'react';
import type { SelectItem } from './components/Select.js';
import type { SettingRow } from './components/SettingsPanel.js';
import { useRefState } from './use-ref-state.js';

/** Panels drawn over the prompt. Each takes the keyboard while it is open. */
export type Overlay =
  | { kind: 'shortcuts' }
  | { kind: 'snake'; best: number; resolve: (score: number) => void }
  | {
      kind: 'settings';
      title: string;
      rows: readonly SettingRow[];
      onChange: (key: string, value: string) => Promise<readonly SettingRow[] | undefined>;
      resolve: (action: string | undefined) => void;
    }
  /** Ctrl+O: searchable transcript with turn details. */
  | { kind: 'transcript' }
  /** Ctrl+G: files changed this session. */
  | { kind: 'changes' }
  | { kind: 'rewind' }
  | {
      kind: 'picker';
      title: string;
      items: readonly SelectItem<unknown>[];
      searchable: boolean;
      resolve: (v: unknown) => void;
    }
  | {
      kind: 'ask';
      title: string;
      placeholder: string;
      mask: boolean;
      resolve: (v: string | undefined) => void;
    };

/** Overlays that handle every key themselves (the prompt and global keys stay out of the way). */
export function ownsKeyboard(ov: Overlay | undefined): boolean {
  return ov !== undefined && ov.kind !== 'shortcuts';
}

/** The overlay state plus promise-returning helpers for commands (pick, ask, settings, game). */
export function useOverlays(): {
  overlay: Overlay | undefined;
  overlayRef: RefObject<Overlay | undefined>;
  setOverlay: (next: Overlay | undefined) => void;
  pick: <T>(
    title: string,
    items: readonly SelectItem<T>[],
    opts?: { searchable?: boolean },
  ) => Promise<T | undefined>;
  ask: (
    title: string,
    placeholder: string,
    opts?: { mask?: boolean },
  ) => Promise<string | undefined>;
  editSettings: (
    title: string,
    rows: readonly SettingRow[],
    onChange: (key: string, value: string) => Promise<readonly SettingRow[] | undefined>,
  ) => Promise<string | undefined>;
  playSnake: (best: number) => Promise<number>;
} {
  const [overlay, setOverlay, overlayRef] = useRefState<Overlay | undefined>(undefined);
  const close = (): void => {
    setOverlay(undefined);
  };
  return {
    overlay,
    overlayRef,
    setOverlay,
    pick: <T>(
      title: string,
      items: readonly SelectItem<T>[],
      opts: { searchable?: boolean } = {},
    ) =>
      new Promise<T | undefined>((resolve) => {
        setOverlay({
          kind: 'picker',
          title,
          items,
          searchable: opts.searchable === true,
          resolve: (v) => {
            close();
            resolve(v as T | undefined);
          },
        });
      }),
    ask: (title, placeholder, opts = {}) =>
      new Promise((resolve) => {
        setOverlay({
          kind: 'ask',
          title,
          placeholder,
          mask: opts.mask === true,
          resolve: (v) => {
            close();
            resolve(v);
          },
        });
      }),
    editSettings: (title, rows, onChange) =>
      new Promise((resolve) => {
        setOverlay({
          kind: 'settings',
          title,
          rows,
          onChange,
          resolve: (action) => {
            close();
            resolve(action);
          },
        });
      }),
    playSnake: (best) =>
      new Promise((resolve) => {
        setOverlay({
          kind: 'snake',
          best,
          resolve: (score) => {
            close();
            resolve(score);
          },
        });
      }),
  };
}
