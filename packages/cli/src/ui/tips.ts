/** Tips shown on the welcome panel. Only describe features that exist. */
export const TIPS: readonly string[] = [
  'End a line with \\ and press Enter to start a new line (Shift+Enter works in most modern terminals)',
  'Press Ctrl+R to search your prompt history for this project',
  'Press Esc to stop a response — what was written so far is kept',
  'Press ? on an empty prompt to see every keyboard shortcut',
  'Rate-limited on Groq? VinaX switches down your fallback chain automatically',
  'Pipe text in from scripts: git diff | vinax -p "write a commit message"',
  'Press Ctrl+O to see which model answered each turn and how many tokens it used',
  'Shift+Tab cycles between default, auto-accept edits and plan mode',
];

export function pickTips(count: number, random: () => number = Math.random): string[] {
  const pool = [...TIPS];
  const out: string[] = [];
  while (out.length < count && pool.length > 0) {
    out.push(...pool.splice(Math.floor(random() * pool.length), 1));
  }
  return out;
}
