import { execFile } from 'node:child_process';

/**
 * Hands a URL to the desktop's browser. Failures are ignored on purpose: there is nothing useful
 * to say when a headless or locked-down machine has no handler, and the URL is always printed too.
 */
export function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url]]
        : ['xdg-open', [url]];
  execFile(cmd, args, () => undefined);
}
