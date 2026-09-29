/**
 * The VinaX logo for terminals: the word "VinaX" in striped block letters, coloured in three
 * bands (saffron, white, green) with a blue chakra in the "a", after the brand artwork in
 * `brand/`. Each filled cell is drawn with "▀" so the letters show as horizontal stripes.
 */

/** Seven rows; `#` is a filled cell, `o` the chakra, anything else is empty. */
const GLYPHS: Record<'V' | 'i' | 'n' | 'a' | 'X', readonly string[]> = {
  V: [
    '###     ###',
    '###     ###',
    ' ###   ### ',
    ' ###   ### ',
    '  ### ###  ',
    '   #####   ',
    '    ###    ',
  ],
  i: ['###', '   ', '###', '###', '###', '###', '###'],
  n: ['         ', '         ', '######## ', '###   ###', '###   ###', '###   ###', '###   ###'],
  a: ['         ', '         ', ' ########', '###   ###', '### o ###', '###   ###', ' ########'],
  X: [
    '###     ###',
    ' ###   ### ',
    '  ### ###  ',
    '   #####   ',
    '  ### ###  ',
    ' ###   ### ',
    '###     ###',
  ],
};

const WORD = ['V', 'i', 'n', 'a', 'X'] as const;

export const LOGO_HEIGHT = 7;

/** The grid of the whole word, one string per row, letters one column apart. */
export const LOGO_GRID: readonly string[] = Array.from({ length: LOGO_HEIGHT }, (_, row) =>
  WORD.map((l) => GLYPHS[l][row] ?? '').join(' '),
);

export const LOGO_WIDTH = Math.max(...LOGO_GRID.map((r) => r.length));

export type Band = 'saffron' | 'white' | 'green';

/** Rows 0–2 saffron, 3–4 white, 5–6 green: the proportions of the artwork. */
export function bandFor(row: number): Band {
  return row < 3 ? 'saffron' : row < 5 ? 'white' : 'green';
}

export const BRAND_COLORS = {
  saffron: '#FF9933',
  white: '#F8FAFC',
  /** White disappears on a light background, so light themes use a soft grey band instead. */
  whiteOnLight: '#9CA3AF',
  green: '#3CB043',
  chakra: '#1D4ED8',
} as const;

export interface LogoSegment {
  text: string;
  kind: 'fill' | 'chakra' | 'space';
}

/** A row split into runs of fill, chakra and space, ready to colour. */
export function logoSegments(row: string, ascii = false): LogoSegment[] {
  const out: LogoSegment[] = [];
  for (const ch of row) {
    const kind: LogoSegment['kind'] = ch === '#' ? 'fill' : ch === 'o' ? 'chakra' : 'space';
    const glyph =
      kind === 'fill' ? (ascii ? '=' : '▀') : kind === 'chakra' ? (ascii ? 'o' : '✺') : ' ';
    const last = out.at(-1);
    if (last?.kind === kind) last.text += glyph;
    else out.push({ text: glyph, kind });
  }
  return out;
}

export const TAGLINE = 'AI coding agent for the terminal';

/** Narrowest box that still fits the big logo (the logo plus the box's border and padding). */
export const LOGO_MIN_WIDTH = LOGO_WIDTH + 4;

/** `TERM=dumb` terminals get plain ASCII instead of block characters. */
export function asciiOnly(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.TERM === 'dumb';
}
