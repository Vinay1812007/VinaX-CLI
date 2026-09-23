import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { z } from 'zod';
import { settingsPaths, type Env } from './paths.js';
import { resolveSettings, settingsSchema, type ResolvedSettings, type Settings } from './schema.js';

export type SettingsSource = 'user' | 'project' | 'local' | 'cli';
export type WritableScope = Exclude<SettingsSource, 'cli'>;

export class SettingsError extends Error {
  constructor(
    readonly label: string,
    readonly issues: string[],
  ) {
    super(`Invalid settings in ${label}:\n${issues.map((i) => `  • ${i}`).join('\n')}`);
    this.name = 'SettingsError';
  }
}

export interface ParsedSettings {
  settings: Settings;
  warnings: string[];
}

function issuePath(p: readonly PropertyKey[]): string {
  return p.length === 0 ? '(root)' : p.map(String).join('.');
}

function deleteAt(root: unknown, at: readonly PropertyKey[], key: string): void {
  let node: unknown = root;
  for (const seg of at) {
    if (typeof node !== 'object' || node === null) return;
    node = (node as Record<PropertyKey, unknown>)[seg];
  }
  if (typeof node === 'object' && node !== null) {
    Reflect.deleteProperty(node, key);
  }
}

/**
 * Validates raw settings. Unknown keys become warnings (so a newer settings file still loads);
 * wrong types or values are errors that name the exact key.
 */
export function parseSettings(raw: unknown, label: string): ParsedSettings {
  const input: unknown = structuredClone(raw);
  const warnings: string[] = [];
  for (;;) {
    const result = settingsSchema.safeParse(input);
    if (result.success) return { settings: result.data, warnings: warnings.sort() };
    const unknownKeys = result.error.issues.filter(
      (i): i is z.core.$ZodIssueUnrecognizedKeys => i.code === 'unrecognized_keys',
    );
    const other = result.error.issues.filter((i) => i.code !== 'unrecognized_keys');
    if (other.length > 0) {
      throw new SettingsError(
        label,
        other.map((i) => `${issuePath(i.path)}: ${i.message}`),
      );
    }
    for (const issue of unknownKeys) {
      for (const key of issue.keys) {
        warnings.push(`Unknown setting "${issuePath([...issue.path, key])}" in ${label} (ignored)`);
        deleteAt(input, issue.path, key);
      }
    }
  }
}

export async function readSettingsFile(file: string): Promise<ParsedSettings> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { settings: {}, warnings: [] };
    throw err;
  }
  if (text.trim() === '') return { settings: {}, warnings: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new SettingsError(file, [`not valid JSON (${(err as Error).message})`]);
  }
  return parseSettings(raw, file);
}

const CONCAT_ARRAYS = new Set(['allow', 'ask', 'deny', 'additionalDirectories']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function mergeInto(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
  parentKey: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) continue;
    const prev = out[key];
    if (isPlainObject(prev) && isPlainObject(value)) {
      out[key] = mergeInto(prev, value, key);
    } else if (
      parentKey === 'permissions' &&
      CONCAT_ARRAYS.has(key) &&
      Array.isArray(prev) &&
      Array.isArray(value)
    ) {
      out[key] = [...new Set([...(prev as unknown[]), ...(value as unknown[])])];
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Merges layers from lowest to highest precedence. Later layers override scalars and replace
 * arrays, except permission rule lists, which accumulate across layers (deny still wins at match time).
 */
export function mergeSettings(layers: readonly Settings[]): Settings {
  let merged: Record<string, unknown> = {};
  for (const layer of layers) merged = mergeInto(merged, layer, '');
  return merged;
}

export interface SettingsLayer {
  source: SettingsSource;
  file?: string;
  settings: Settings;
}

export interface LoadedSettings {
  resolved: ResolvedSettings;
  merged: Settings;
  layers: SettingsLayer[];
  warnings: string[];
}

export async function loadSettings(opts: {
  cwd: string;
  env?: Env;
  cli?: Settings;
}): Promise<LoadedSettings> {
  const paths = settingsPaths(opts.cwd, opts.env);
  const layers: SettingsLayer[] = [];
  const warnings: string[] = [];
  for (const source of ['user', 'project', 'local'] as const) {
    const file = paths[source];
    const parsed = await readSettingsFile(file);
    warnings.push(...parsed.warnings);
    layers.push({ source, file, settings: parsed.settings });
  }
  if (opts.cli)
    layers.push({
      source: 'cli',
      settings: parseSettings(opts.cli, 'command-line flags').settings,
    });
  const merged = mergeSettings(layers.map((l) => l.settings));
  return { resolved: resolveSettings(merged), merged, layers, warnings };
}

/**
 * Reads one settings file, applies `mutate`, validates the result and writes it back.
 * Writing the local scope also makes sure git ignores it.
 */
export async function updateSettingsFile(
  opts: { cwd: string; env?: Env; scope: WritableScope },
  mutate: (current: Record<string, unknown>) => Record<string, unknown>,
): Promise<string> {
  const file = settingsPaths(opts.cwd, opts.env)[opts.scope];
  let current: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    if (isPlainObject(parsed)) current = parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const next = mutate(structuredClone(current));
  parseSettings(next, file);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  if (opts.scope === 'local') await ensureGitIgnored(opts.cwd, '.vinax/settings.local.json');
  return file;
}

const execFileAsync = promisify(execFile);

async function ensureGitIgnored(cwd: string, entry: string): Promise<void> {
  try {
    await execFileAsync('git', ['check-ignore', '-q', entry], { cwd });
    return; // exit 0: already ignored
  } catch (err) {
    // exit 1 = not ignored; anything else (not a repo, no git) = nothing to do
    if ((err as { code?: unknown }).code !== 1) return;
  }
  const gitignore = path.join(cwd, '.gitignore');
  let existing = '';
  try {
    existing = await fs.readFile(gitignore, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const sep = existing === '' || existing.endsWith('\n') ? '' : '\n';
  await fs.appendFile(gitignore, `${sep}${entry}\n`, 'utf8');
}
