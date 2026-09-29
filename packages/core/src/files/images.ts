import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ImageAttachment, ImageMediaType } from '../providers/types.js';

const execFileAsync = promisify(execFile);

/** Providers cap inline images around 4–5 MB; larger ones are shrunk on macOS or refused. */
export const MAX_IMAGE_BYTES = 3_750_000;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

/** The image type from the file's first bytes, or `undefined` for anything else. */
export function sniffImageType(bytes: Uint8Array): ImageMediaType | undefined {
  const b = (i: number) => bytes[i] ?? -1;
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) return 'image/png';
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'image/jpeg';
  if (b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46) return 'image/gif';
  if (
    b(0) === 0x52 &&
    b(1) === 0x49 &&
    b(2) === 0x46 &&
    b(3) === 0x46 &&
    b(8) === 0x57 &&
    b(9) === 0x45 &&
    b(10) === 0x42 &&
    b(11) === 0x50
  )
    return 'image/webp';
  return undefined;
}

export function looksLikeImagePath(p: string): boolean {
  return IMAGE_EXT.test(p);
}

/** Shrinks a large image with macOS `sips`; returns the new file, or `undefined`. */
async function shrinkWithSips(file: string): Promise<string | undefined> {
  if (process.platform !== 'darwin') return undefined;
  const out = path.join(os.tmpdir(), `vinax-img-${String(process.pid)}-${String(Date.now())}.jpg`);
  try {
    await execFileAsync(
      'sips',
      ['-Z', '1800', '-s', 'format', 'jpeg', '-s', 'formatOptions', '80', file, '--out', out],
      { timeout: 15_000 },
    );
    return out;
  } catch {
    return undefined;
  }
}

/** Reads an image file into an attachment; throws a readable error for non-images. */
export async function loadImage(file: string): Promise<ImageAttachment> {
  let bytes = await fs.readFile(file);
  let type = sniffImageType(bytes);
  if (type === undefined)
    throw new Error(`${path.basename(file)} is not a PNG, JPEG, GIF or WebP image`);
  if (bytes.length > MAX_IMAGE_BYTES) {
    const smaller = await shrinkWithSips(file);
    if (smaller !== undefined) {
      bytes = await fs.readFile(smaller);
      type = 'image/jpeg';
      await fs.rm(smaller, { force: true });
    }
    if (bytes.length > MAX_IMAGE_BYTES)
      throw new Error(
        `${path.basename(file)} is ${(bytes.length / 1_000_000).toFixed(1)} MB; images must be under ${String(MAX_IMAGE_BYTES / 1_000_000)} MB`,
      );
  }
  return { mediaType: type, data: bytes.toString('base64'), name: path.basename(file) };
}

/**
 * Image file paths in a prompt: `@shot.png`, quoted paths, and paths pasted by dragging a file
 * into the terminal (which escapes spaces as `\ `). Returns each match with its span.
 */
export function findImagePaths(text: string): { start: number; end: number; path: string }[] {
  const found: { start: number; end: number; path: string }[] = [];
  const patterns = [
    // "quoted path.png" or 'quoted path.png'
    /(["'])((?:[~/.]|[A-Za-z]:\\)[^"'\n]*?\.(?:png|jpe?g|gif|webp))\1/gi,
    // @path, ~/path, /abs/path or ./rel/path with optional backslash-escaped spaces
    /(^|\s)@?((?:~\/|\/|\.{1,2}\/|[A-Za-z]:\\)(?:\\ |[^\s"'])+?\.(?:png|jpe?g|gif|webp))(?=$|[\s,.;:!?)])/gi,
    // @relative/name.png
    /(^|\s)@((?:\\ |[^\s"'@])+?\.(?:png|jpe?g|gif|webp))(?=$|[\s,.;:!?)])/gi,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const raw = m[2] ?? '';
      const lead = m[1] !== undefined && /^\s$/.test(m[1]) ? m[1].length : 0;
      const start = m.index + (re === patterns[0] ? 0 : lead);
      const end = m.index + m[0].length;
      if (found.some((f) => start < f.end && end > f.start)) continue;
      found.push({ start, end, path: raw.replace(/\\ /g, ' ') });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

export function resolveImagePath(p: string, cwd: string): string {
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return path.resolve(cwd, p);
}

/**
 * Replaces image paths in `text` with `[Image #n]` and loads them. Paths that do not exist or
 * are not images are left alone; unreadable images are reported in `errors`.
 */
export async function extractImages(
  text: string,
  cwd: string,
  first = 1,
): Promise<{ text: string; images: ImageAttachment[]; errors: string[] }> {
  const images: ImageAttachment[] = [];
  const errors: string[] = [];
  let out = '';
  let pos = 0;
  for (const hit of findImagePaths(text)) {
    const file = resolveImagePath(hit.path, cwd);
    try {
      await fs.access(file);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES') {
        errors.push(
          `Can't read ${path.basename(file)}: the system blocks access to that folder. ${
            process.platform === 'darwin'
              ? 'Copy the screenshot to the clipboard (Ctrl+Shift+Cmd+4) and press Ctrl+V, or save it to your Desktop first.'
              : 'Save it somewhere readable, or copy it and press Ctrl+V.'
          }`,
        );
      }
      continue;
    }
    try {
      images.push(await loadImage(file));
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
      continue;
    }
    const lead = /^\s/.test(text.slice(hit.start, hit.start + 1)) ? text[hit.start] : '';
    out += `${text.slice(pos, hit.start)}${lead ?? ''}[Image #${String(first + images.length - 1)}]`;
    pos = hit.end;
  }
  out += text.slice(pos);
  return { text: out, images, errors };
}

/**
 * Saves the clipboard's image to a temporary PNG (macOS, Wayland/X11 Linux, Windows) and returns
 * its path, or `undefined` when the clipboard holds no image.
 */
export async function clipboardImageFile(): Promise<string | undefined> {
  const out = path.join(os.tmpdir(), `vinax-clip-${String(process.pid)}-${String(Date.now())}.png`);
  try {
    if (process.platform === 'darwin') {
      const script = [
        'set f to (open for access POSIX file "' + out + '" with write permission)',
        'try',
        '  write (the clipboard as «class PNGf») to f',
        'end try',
        'close access f',
      ].join('\n');
      await execFileAsync('osascript', ['-e', script], { timeout: 10_000 });
    } else if (process.platform === 'win32') {
      const ps = `Add-Type -AssemblyName System.Windows.Forms; $i=[System.Windows.Forms.Clipboard]::GetImage(); if ($i) { $i.Save('${out.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png) }`;
      await execFileAsync('powershell', ['-NoProfile', '-STA', '-Command', ps], {
        timeout: 10_000,
      });
    } else {
      const { stdout } = await execFileAsync('wl-paste', ['--type', 'image/png'], {
        encoding: 'buffer',
        timeout: 10_000,
        maxBuffer: 50 * 1024 * 1024,
      }).catch(() =>
        execFileAsync('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o'], {
          encoding: 'buffer',
          timeout: 10_000,
          maxBuffer: 50 * 1024 * 1024,
        }),
      );
      await fs.writeFile(out, stdout);
    }
    const bytes = await fs.readFile(out);
    if (bytes.length === 0 || sniffImageType(bytes) === undefined) {
      await fs.rm(out, { force: true });
      return undefined;
    }
    return out;
  } catch {
    await fs.rm(out, { force: true }).catch(() => undefined);
    return undefined;
  }
}
