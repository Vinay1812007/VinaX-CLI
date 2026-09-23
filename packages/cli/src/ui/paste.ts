/** Pastes at least this long (or with this many lines) collapse into a placeholder. */
const COLLAPSE_CHARS = 800;
const COLLAPSE_LINES = 8;

/**
 * Keeps large pastes out of the input box: each becomes `[Pasted text #n +L lines]` and is
 * expanded back to its full content when the prompt is submitted.
 */
export class PasteStore {
  private readonly pastes = new Map<string, string>();
  private counter = 0;

  /** Returns the text to insert into the editor for this paste. */
  add(raw: string): string {
    const text = raw.replace(/\r\n?/g, '\n');
    const lines = text.split('\n').length;
    if (text.length < COLLAPSE_CHARS && lines < COLLAPSE_LINES) return text;
    this.counter++;
    const label =
      lines > 1
        ? `[Pasted text #${this.counter} +${lines} lines]`
        : `[Pasted text #${this.counter} ${text.length} chars]`;
    this.pastes.set(label, text);
    return label;
  }

  expand(value: string): string {
    let out = value;
    for (const [label, text] of this.pastes) out = out.split(label).join(text);
    return out;
  }

  clear(): void {
    this.pastes.clear();
  }
}
