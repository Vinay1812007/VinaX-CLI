// Control characters are single UTF-16 code units, so scanning code units is safe for any text
// (surrogate pairs and emoji never contain them).
function isControlCode(code: number): boolean {
  return code < 0x20 || code === 0x7f;
}

/** True for typed text: non-empty and free of control characters. */
export function isPrintable(input: string): boolean {
  if (input === '') return false;
  for (let i = 0; i < input.length; i++) if (isControlCode(input.charCodeAt(i))) return false;
  return true;
}

/** Normalises line endings and drops control characters other than newline. */
export function cleanTyped(input: string): string {
  const text = input.replace(/\r\n?/g, '\n');
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x0a || !isControlCode(code)) out += text[i] ?? '';
  }
  return out;
}
