/**
 * The VinaX mark for terminals: a geometric "VX" drawn with box-drawing diagonals, two rows tall
 * so it never crowds a narrow window. It reads the same with or without colour.
 */
export const VX_MARK: readonly string[] = ['╲  ╱ ╲╱', ' ╲╱  ╱╲'];

/** Plain-ASCII variant for terminals without box-drawing glyphs (TERM=dumb). */
export const VX_MARK_ASCII: readonly string[] = ['\\  / \\/', ' \\/  /\\'];

export const TAGLINE = 'AI coding agent for the terminal';

/** Narrowest window that still shows the mark beside the name. */
export const MARK_MIN_WIDTH = 40;

export function markFor(env: Readonly<Record<string, string | undefined>>): readonly string[] {
  return env.TERM === 'dumb' ? VX_MARK_ASCII : VX_MARK;
}
