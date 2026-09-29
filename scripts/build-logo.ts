/**
 * Draws the VinaX logo SVGs in brand/ from the same letter grid the terminal uses
 * (packages/cli/src/ui/brand.ts), so the two never drift apart. Run with:
 *
 *   pnpm brand:build
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  bandFor,
  BRAND_COLORS,
  LOGO_GRID,
  LOGO_HEIGHT,
  LOGO_WIDTH,
} from '../packages/cli/src/ui/brand.js';

const CELL_W = 12;
const CELL_H = 18;
/** Each grid row is drawn as two stripes with thin gaps, like the artwork's striped letters. */
const STRIPES = 2;
const STRIPE_H = 7.5;
const STRIPE_GAP = 1.5;
const PAD = 24;

function chakra(cx: number, cy: number, r: number, color: string, fill: string): string {
  const spokes = Array.from({ length: 24 }, (_, i) => {
    const a = (i * Math.PI) / 12;
    const x = (cx + Math.cos(a) * r * 0.86).toFixed(2);
    const y = (cy + Math.sin(a) * r * 0.86).toFixed(2);
    return `<line x1="${String(cx)}" y1="${String(cy)}" x2="${x}" y2="${y}"/>`;
  }).join('');
  return [
    `<circle cx="${String(cx)}" cy="${String(cy)}" r="${String(r)}" fill="${fill}" stroke="${color}" stroke-width="${String(r * 0.16)}"/>`,
    `<g stroke="${color}" stroke-width="${String(r * 0.07)}">${spokes}</g>`,
    `<circle cx="${String(cx)}" cy="${String(cy)}" r="${String(r * 0.2)}" fill="${color}"/>`,
  ].join('');
}

/** The V and X of the logo side by side: the square mark for favicons and app icons. */
const MARK_GRID: readonly string[] = LOGO_GRID.map(
  (row) => `${row.slice(0, 11)} ${row.slice(-11)}`,
);

function logo(opts: {
  mono: boolean;
  background: boolean;
  grid?: readonly string[];
  square?: boolean;
}): string {
  const grid = opts.grid ?? LOGO_GRID;
  const cols = opts.grid ? Math.max(...grid.map((r) => r.length)) : LOGO_WIDTH;
  const contentW = cols * CELL_W;
  const contentH = LOGO_HEIGHT * CELL_H;
  const width = (opts.square === true ? Math.max(contentW, contentH) : contentW) + PAD * 2;
  const height = (opts.square === true ? Math.max(contentW, contentH) : contentH) + PAD * 2;
  const offX = (width - contentW) / 2;
  const offY = (height - contentH) / 2;
  const parts: string[] = [];
  if (opts.background)
    parts.push(
      `<rect width="${String(width)}" height="${String(height)}" rx="${opts.square === true ? '40' : '18'}" fill="#0A0A0A"/>`,
    );
  let hub: { x: number; y: number } | undefined;
  for (const [row, line] of grid.entries()) {
    const color = opts.mono ? 'currentColor' : BRAND_COLORS[bandFor(row)];
    let col = 0;
    while (col < line.length) {
      const ch = line[col];
      if (ch === 'o') hub = { x: col, y: row };
      if (ch !== '#') {
        col++;
        continue;
      }
      let end = col;
      while (line[end] === '#') end++;
      for (let k = 0; k < STRIPES; k++) {
        const y = offY + row * CELL_H + k * (STRIPE_H + STRIPE_GAP);
        parts.push(
          `<rect x="${String(offX + col * CELL_W)}" y="${String(y)}" width="${String((end - col) * CELL_W - 1)}" height="${String(STRIPE_H)}" rx="1" fill="${color}"/>`,
        );
      }
      col = end;
    }
  }
  if (hub) {
    const cx = offX + hub.x * CELL_W + CELL_W / 2;
    const cy = offY + hub.y * CELL_H + (STRIPES * (STRIPE_H + STRIPE_GAP)) / 2;
    parts.push(
      chakra(
        cx,
        cy,
        CELL_H * 0.95,
        opts.mono ? 'currentColor' : BRAND_COLORS.chakra,
        opts.mono ? 'none' : '#FFFFFF',
      ),
    );
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(width)} ${String(height)}" width="${String(width)}" height="${String(height)}" role="img" aria-label="VinaX">`,
    '  <title>VinaX</title>',
    ...parts.map((p) => `  ${p}`),
    '</svg>',
    '',
  ].join('\n');
}

const root = path.resolve(import.meta.dirname, '..');
const files: Record<string, string> = {
  'brand/vinax-logo.svg': logo({ mono: false, background: true }),
  'brand/vinax-logo-transparent.svg': logo({ mono: false, background: false }),
  'brand/vinax-logo-mono.svg': logo({ mono: true, background: false }),
  'brand/vinax-mark.svg': logo({ mono: false, background: true, grid: MARK_GRID, square: true }),
  'brand/vinax-mark-mono.svg': logo({
    mono: true,
    background: false,
    grid: MARK_GRID,
    square: true,
  }),
  'docs/public/vinax-logo.svg': logo({ mono: false, background: true }),
  'docs/public/logo.svg': logo({ mono: false, background: true, grid: MARK_GRID, square: true }),
  'docs/public/favicon.svg': logo({ mono: false, background: true, grid: MARK_GRID, square: true }),
};
for (const [rel, svg] of Object.entries(files)) {
  await writeFile(path.join(root, rel), svg, 'utf8');
  console.log(`wrote ${rel}`);
}
