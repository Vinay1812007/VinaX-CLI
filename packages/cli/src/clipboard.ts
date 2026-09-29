import { spawn } from 'node:child_process';

/** Clipboard programs to try, per platform. */
function candidates(): [string, string[]][] {
  if (process.platform === 'darwin') return [['pbcopy', []]];
  if (process.platform === 'win32') return [['clip', []]];
  return [
    ['wl-copy', []],
    ['xclip', ['-selection', 'clipboard']],
    ['xsel', ['--clipboard', '--input']],
  ];
}

function pipeTo(cmd: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
      child.on('error', () => {
        resolve(false);
      });
      child.on('close', (code) => {
        resolve(code === 0);
      });
      child.stdin.end(text);
    } catch {
      resolve(false);
    }
  });
}

/**
 * Copies text to the system clipboard. Falls back to the OSC 52 escape sequence, which most
 * modern terminals (iTerm2, WezTerm, kitty, Windows Terminal, tmux with set-clipboard) honour
 * even over SSH. Returns how it was copied.
 */
export async function copyToClipboard(
  text: string,
  write: (s: string) => void = (s) => process.stdout.write(s),
  programs: [string, string[]][] = process.env.VINAX_CLIPBOARD === 'osc52' ? [] : candidates(),
): Promise<'system' | 'osc52'> {
  for (const [cmd, args] of programs) if (await pipeTo(cmd, args, text)) return 'system';
  write(`\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`);
  return 'osc52';
}

/** Fenced code blocks in Markdown, in order. */
export function codeBlocks(markdown: string): { lang: string; code: string }[] {
  const out: { lang: string; code: string }[] = [];
  const re = /^(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)^\1[ \t]*$/gm;
  for (const m of markdown.matchAll(re)) out.push({ lang: (m[2] ?? '').trim(), code: m[3] ?? '' });
  return out;
}
