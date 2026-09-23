import type {
  AgentSetup,
  EditorMode,
  PermissionMode,
  Runtime,
  SessionWriter,
  ThemeName,
} from '@vinax/core';
import type { SelectItem } from '../components/Select.js';

/** What a slash command can do to the running session. */
export interface CommandContext {
  runtime: Runtime;
  setup: AgentSetup;
  session: SessionWriter;
  /** Everything typed after the command name. */
  args: string;
  /** Shows a bordered Markdown panel in the transcript. */
  panel: (title: string, markdown: string) => void;
  notice: (level: 'info' | 'warning' | 'error', text: string) => void;
  /** Runs an agent turn as if the user had typed `prompt`. */
  send: (
    prompt: string,
    opts?: { display?: string; allowRules?: readonly string[]; model?: string },
  ) => void;
  pick: <T>(title: string, items: readonly SelectItem<T>[]) => Promise<T | undefined>;
  ask: (
    title: string,
    placeholder: string,
    opts?: { mask?: boolean },
  ) => Promise<string | undefined>;
  /** Shows an activity line while `task` runs; Esc aborts it through the signal. */
  busy: <T>(label: string, task: (signal: AbortSignal) => Promise<T>) => Promise<T | undefined>;
  mode: () => PermissionMode;
  setMode: (mode: PermissionMode) => void;
  setTheme: (theme: ThemeName) => void;
  setEditorMode: (mode: EditorMode) => void;
  editorMode: () => EditorMode;
  /** Starts a fresh conversation (new session). */
  clear: () => void;
  resume: (id: string) => void;
  openRewind: () => void;
  /** Hands the terminal to a child process (e.g. $EDITOR). */
  suspend: (fn: () => void | Promise<void>) => Promise<void>;
  contextPct: () => number | undefined;
  exit: () => void;
  commands: () => readonly SlashCommand[];
  sessionTitle: () => string | undefined;
}

export interface SlashCommand {
  name: string;
  aliases?: readonly string[];
  description: string;
  argumentHint?: string | undefined;
  source: 'builtin' | 'project' | 'user';
  run: (ctx: CommandContext) => void | Promise<void>;
}

/** `/name rest of args` → ['name', 'rest of args']; undefined when `text` is not a command. */
export function parseSlash(text: string): { name: string; args: string } | undefined {
  const m = /^\/([A-Za-z0-9_:-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m?.[1]) return undefined;
  return { name: m[1].toLowerCase(), args: (m[2] ?? '').trim() };
}
