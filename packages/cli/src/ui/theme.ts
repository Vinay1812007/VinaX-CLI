import { createContext, useContext } from 'react';
import type { Env, ThemeName } from '@vinax/core';

export type CodeRole =
  | 'keyword'
  | 'string'
  | 'number'
  | 'comment'
  | 'title'
  | 'type'
  | 'literal'
  | 'attr'
  | 'meta'
  | 'variable';

/** Colours are hex strings; `undefined` means "terminal default". The mono theme has none. */
export interface Theme {
  name: ThemeName | 'mono';
  color: boolean;
  accent: string | undefined;
  muted: string | undefined;
  success: string | undefined;
  warning: string | undefined;
  error: string | undefined;
  code: Record<CodeRole, string | undefined>;
}

const dark: Theme = {
  name: 'dark',
  color: true,
  accent: '#14B8A6',
  muted: '#8B949E',
  success: '#22C55E',
  warning: '#F59E0B',
  error: '#F87171',
  code: {
    keyword: '#C084FC',
    string: '#86EFAC',
    number: '#FDBA74',
    comment: '#6B7280',
    title: '#5EEAD4',
    type: '#93C5FD',
    literal: '#FDBA74',
    attr: '#FDE68A',
    meta: '#94A3B8',
    variable: '#F9A8D4',
  },
};

const light: Theme = {
  name: 'light',
  color: true,
  accent: '#0F766E',
  muted: '#6B7280',
  success: '#15803D',
  warning: '#B45309',
  error: '#B91C1C',
  code: {
    keyword: '#7C3AED',
    string: '#15803D',
    number: '#C2410C',
    comment: '#9CA3AF',
    title: '#0F766E',
    type: '#1D4ED8',
    literal: '#C2410C',
    attr: '#A16207',
    meta: '#64748B',
    variable: '#BE185D',
  },
};

/** Okabe–Ito palette: blue/orange instead of green/red. */
const colorblind: Theme = {
  name: 'colorblind',
  color: true,
  accent: '#56B4E9',
  muted: '#999999',
  success: '#0072B2',
  warning: '#E69F00',
  error: '#D55E00',
  code: {
    keyword: '#CC79A7',
    string: '#56B4E9',
    number: '#E69F00',
    comment: '#999999',
    title: '#009E73',
    type: '#0072B2',
    literal: '#E69F00',
    attr: '#F0E442',
    meta: '#999999',
    variable: '#CC79A7',
  },
};

const mono: Theme = {
  name: 'mono',
  color: false,
  accent: undefined,
  muted: undefined,
  success: undefined,
  warning: undefined,
  error: undefined,
  code: {
    keyword: undefined,
    string: undefined,
    number: undefined,
    comment: undefined,
    title: undefined,
    type: undefined,
    literal: undefined,
    attr: undefined,
    meta: undefined,
    variable: undefined,
  },
};

export const THEMES: Record<ThemeName, Theme> = { dark, light, colorblind };

export const THEME_LABELS: Record<ThemeName, string> = {
  dark: 'Dark',
  light: 'Light',
  colorblind: 'Colour-blind friendly (dark)',
};

export function colorDisabled(env: Env): boolean {
  return env.NO_COLOR !== undefined && env.NO_COLOR !== '';
}

/** `NO_COLOR` always wins over the configured theme. */
export function resolveTheme(name: ThemeName, env: Env): Theme {
  return colorDisabled(env) ? mono : THEMES[name];
}

export const ThemeContext = createContext<Theme>(dark);

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
