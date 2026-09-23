/** One simple command inside a (possibly compound) shell command line. */
export interface SimpleCommand {
  /** The command's own text, trimmed, e.g. `npm run test`. */
  text: string;
  /** Words with quotes removed, e.g. ['git', 'commit', '-m', 'fix bug']. */
  words: string[];
  /** Output redirection targets (`> file`, `>> file`, `2> file`). */
  redirects: string[];
}

const SEPARATORS = ['&&', '||', ';', '|', '\n', '&'];

/**
 * Splits a command line on `&&`, `||`, `;`, `|`, `&` and newlines, honouring quotes and `$(…)`.
 * It is a conservative tokenizer for permission checks, not a full shell parser: anything it
 * cannot understand stays inside one command's text, which makes rule matching stricter.
 */
export function splitCommands(line: string): SimpleCommand[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] ?? '';
    if (quote) {
      current += ch;
      if (ch === '\\' && quote === '"') {
        current += line[++i] ?? '';
      } else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '\\') {
      current += ch + (line[++i] ?? '');
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '$' && line[i + 1] === '(') depth++;
    if (ch === ')' && depth > 0) depth--;
    if (depth === 0) {
      const sep = SEPARATORS.find((s) => line.startsWith(s, i));
      // "&" alone is a separator, but not in ">&2" or "&>" redirections
      const isRedirectAmp = sep === '&' && (line[i - 1] === '>' || line[i + 1] === '>');
      if (sep !== undefined && !isRedirectAmp) {
        parts.push(current);
        current = '';
        i += sep.length - 1;
        continue;
      }
    }
    current += ch;
  }
  parts.push(current);
  return parts
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .map(parseSimple);
}

function parseSimple(text: string): SimpleCommand {
  const words: string[] = [];
  const redirects: string[] = [];
  let word = '';
  let quote: '"' | "'" | undefined;
  let inWord = false;
  const flush = (): void => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? '';
    if (quote) {
      if (ch === quote) quote = undefined;
      else if (ch === '\\' && quote === '"' && i + 1 < text.length) word += text[++i] ?? '';
      else word += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
    } else if (ch === '\\' && i + 1 < text.length) {
      word += text[++i] ?? '';
      inWord = true;
    } else if (/\s/.test(ch)) {
      flush();
    } else {
      word += ch;
      inWord = true;
    }
  }
  flush();
  // pull out redirections: ">", ">>", "2>", "&>" followed by a target (attached or separate)
  const plain: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i] ?? '';
    if (/^\d?>&\d$/.test(w)) continue; // fd duplication like 2>&1
    const m = /^(?:\d|&)?>>?(.*)$/.exec(w);
    if (m) {
      const target = m[1] !== undefined && m[1] !== '' ? m[1] : words[++i];
      if (target !== undefined && !target.startsWith('&')) redirects.push(target);
      continue;
    }
    plain.push(w);
  }
  // leading VAR=value assignments are not the command name
  while (plain.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(plain[0] ?? '')) plain.shift();
  return { text, words: plain, redirects };
}
