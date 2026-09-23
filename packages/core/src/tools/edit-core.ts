export interface EditSpec {
  old_string: string;
  new_string: string;
  replace_all?: boolean | undefined;
}

export type EditResult =
  { ok: true; content: string; replacements: number } | { ok: false; error: string };

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length))
    count++;
  return count;
}

/**
 * Exact string replacement. `old_string` must match once (or `replace_all` must be set). Files
 * with CRLF line endings accept `\n`-based strings from the model.
 */
export function applyEdit(content: string, edit: EditSpec): EditResult {
  let { old_string: oldStr, new_string: newStr } = edit;
  if (oldStr === '')
    return {
      ok: false,
      error: 'old_string is empty. To create or overwrite a whole file, use Write.',
    };
  if (oldStr === newStr)
    return { ok: false, error: 'old_string and new_string are identical; nothing to change.' };
  if (content.includes('\r\n') && !oldStr.includes('\r\n') && oldStr.includes('\n')) {
    oldStr = oldStr.replace(/\n/g, '\r\n');
    newStr = newStr.replace(/\r?\n/g, '\r\n');
  }
  const count = countOccurrences(content, oldStr);
  if (count === 0) {
    return {
      ok: false,
      error:
        'old_string was not found. It must match the file exactly, including whitespace and indentation. Read the file again if unsure.',
    };
  }
  if (count > 1 && edit.replace_all !== true) {
    return {
      ok: false,
      error: `old_string appears ${String(count)} times. Include more surrounding lines to make it unique, or set replace_all to true.`,
    };
  }
  const next =
    edit.replace_all === true
      ? content.split(oldStr).join(newStr)
      : content.replace(oldStr, () => newStr);
  return { ok: true, content: next, replacements: edit.replace_all === true ? count : 1 };
}

/** Applies edits in order; all must succeed or nothing changes. */
export function applyEdits(content: string, edits: readonly EditSpec[]): EditResult {
  let current = content;
  let replacements = 0;
  for (const [i, edit] of edits.entries()) {
    const r = applyEdit(current, edit);
    if (!r.ok)
      return {
        ok: false,
        error: `Edit ${String(i + 1)} of ${String(edits.length)}: ${r.error} No changes were made.`,
      };
    current = r.content;
    replacements += r.replacements;
  }
  return { ok: true, content: current, replacements };
}
