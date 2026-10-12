import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { vinaxHome, type Env } from '../config/paths.js';
import {
  hookMatcherSchema,
  HOOK_EVENTS,
  type HookEvent,
  type HookMatcher,
} from '../config/schema.js';

/** What a plugin says about itself, in `.vinax-plugin/plugin.json` or `.claude-plugin/plugin.json`. */
export const pluginManifestSchema = z.looseObject({
  name: z.string().min(1),
  description: z.string().optional(),
  version: z.string().optional(),
  author: z.union([z.string(), z.looseObject({ name: z.string().optional() })]).optional(),
  homepage: z.string().optional(),
});
export type PluginManifest = z.infer<typeof pluginManifestSchema>;

/** One plugin a marketplace offers. `source` is a path inside the marketplace, or a git URL. */
export const marketplaceEntrySchema = z.looseObject({
  name: z.string().min(1),
  source: z.union([z.string(), z.looseObject({ source: z.string().optional() })]).optional(),
  description: z.string().optional(),
  version: z.string().optional(),
});
export type MarketplaceEntry = z.infer<typeof marketplaceEntrySchema>;

export const marketplaceFileSchema = z.looseObject({
  name: z.string().min(1),
  owner: z.unknown().optional(),
  plugins: z.array(marketplaceEntrySchema),
});
export type MarketplaceFile = z.infer<typeof marketplaceFileSchema>;

const configSchema = z.looseObject({
  marketplaces: z
    .record(z.string(), z.looseObject({ source: z.string(), dir: z.string() }))
    .optional(),
  plugins: z
    .record(z.string(), z.looseObject({ marketplace: z.string(), enabled: z.boolean() }))
    .optional(),
});

export interface PluginConfig {
  /** By marketplace name: where it came from, and the local checkout. */
  marketplaces: Record<string, { source: string; dir: string }>;
  /** By `name@marketplace`. */
  plugins: Record<string, { marketplace: string; enabled: boolean }>;
}

/** An installed plugin and what it contributes. */
export interface InstalledPlugin {
  name: string;
  marketplace: string;
  /** `name@marketplace`, the id used by `/plugin`. */
  id: string;
  dir: string;
  enabled: boolean;
  manifest: PluginManifest;
  /** Missing on disk — the marketplace was removed, or the checkout was deleted. */
  missing: boolean;
}

export function pluginsDir(env: Env): string {
  return path.join(vinaxHome(env), 'plugins');
}

function configFile(env: Env): string {
  return path.join(pluginsDir(env), 'config.json');
}

export function emptyPluginConfig(): PluginConfig {
  return { marketplaces: {}, plugins: {} };
}

/** Synchronous: the loaders for commands, skills and agents need this before anything runs. */
export function readPluginConfig(env: Env): PluginConfig {
  try {
    const parsed = configSchema.safeParse(JSON.parse(fs.readFileSync(configFile(env), 'utf8')));
    if (!parsed.success) return emptyPluginConfig();
    return {
      marketplaces: parsed.data.marketplaces ?? {},
      plugins: parsed.data.plugins ?? {},
    };
  } catch {
    return emptyPluginConfig();
  }
}

export async function writePluginConfig(env: Env, config: PluginConfig): Promise<void> {
  await fsp.mkdir(pluginsDir(env), { recursive: true });
  await fsp.writeFile(configFile(env), `${JSON.stringify(config, null, 2)}\n`);
}

/** Where a plugin's checkout lives: `~/.vinax/plugins/installed/<marketplace>/<name>`. */
export function pluginDir(env: Env, marketplace: string, name: string): string {
  return path.join(pluginsDir(env), 'installed', marketplace, name);
}

function manifestPath(dir: string): string | undefined {
  for (const folder of ['.vinax-plugin', '.claude-plugin']) {
    const file = path.join(dir, folder, 'plugin.json');
    if (fs.existsSync(file)) return file;
  }
  return undefined;
}

/** A plugin's manifest, or `undefined` when the folder is not a plugin. */
export function readManifest(dir: string): PluginManifest | undefined {
  const file = manifestPath(dir);
  if (file === undefined) return undefined;
  try {
    const parsed = pluginManifestSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Every installed plugin, enabled or not, newest config order. */
export function listPlugins(env: Env): InstalledPlugin[] {
  const config = readPluginConfig(env);
  return Object.entries(config.plugins).map(([id, entry]) => {
    const name = id.split('@')[0] ?? id;
    const dir = pluginDir(env, entry.marketplace, name);
    const manifest = readManifest(dir);
    return {
      id,
      name,
      marketplace: entry.marketplace,
      dir,
      enabled: entry.enabled,
      manifest: manifest ?? { name },
      missing: manifest === undefined,
    };
  });
}

/** Plugins whose contributions should be loaded: installed, enabled, and present on disk. */
export function activePlugins(env: Env): InstalledPlugin[] {
  return listPlugins(env).filter((p) => p.enabled && !p.missing);
}

/**
 * Folders of a given kind (`commands`, `agents`, `skills`) contributed by active plugins, in a
 * stable order so a clash resolves the same way every time.
 */
export function pluginContribDirs(env: Env, kind: 'commands' | 'agents' | 'skills'): string[] {
  return activePlugins(env)
    .map((p) => path.join(p.dir, kind))
    .filter((dir) => fs.existsSync(dir))
    .sort();
}

const hooksFileSchema = z.looseObject(
  Object.fromEntries(HOOK_EVENTS.map((e) => [e, z.array(hookMatcherSchema).optional()])) as Record<
    HookEvent,
    z.ZodOptional<z.ZodArray<typeof hookMatcherSchema>>
  >,
);

/**
 * Hooks from every active plugin's `hooks/hooks.json`, merged per event. Plugin hooks are added
 * to the ones in settings rather than replacing them, so installing a plugin never silently
 * switches off a hook the user wrote.
 */
export function pluginHooks(env: Env): {
  hooks: Partial<Record<HookEvent, HookMatcher[]>>;
  errors: string[];
} {
  const hooks: Partial<Record<HookEvent, HookMatcher[]>> = {};
  const errors: string[] = [];
  for (const plugin of activePlugins(env)) {
    const file = path.join(plugin.dir, 'hooks', 'hooks.json');
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      errors.push(`${plugin.id}: hooks/hooks.json is not valid JSON (${(err as Error).message})`);
      continue;
    }
    // Claude Code wraps the events in a "hooks" key; accept both shapes
    const body = typeof raw === 'object' && raw !== null && 'hooks' in raw ? raw.hooks : raw;
    const parsed = hooksFileSchema.safeParse(body);
    if (!parsed.success) {
      errors.push(
        `${plugin.id}: hooks/hooks.json — ${z.prettifyError(parsed.error).replace(/\n/g, '; ')}`,
      );
      continue;
    }
    for (const event of HOOK_EVENTS) {
      const list = parsed.data[event];
      if (list === undefined || list.length === 0) continue;
      // a plugin's scripts live beside it, and it cannot know where it was installed
      (hooks[event] ??= []).push(
        ...list.map((matcher) => ({
          ...matcher,
          hooks: matcher.hooks.map((h) => ({
            ...h,
            command: expandPluginRoot(h.command, plugin.dir),
          })),
        })),
      );
    }
  }
  return { hooks, errors };
}

/** `${CLAUDE_PLUGIN_ROOT}/x` and `${VINAX_PLUGIN_ROOT}/x` in a hook command mean the plugin folder. */
export function expandPluginRoot(command: string, dir: string): string {
  return command.replace(/\$\{(?:CLAUDE|VINAX)_PLUGIN_ROOT\}/g, dir);
}

function git(args: string[], cwd: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 120_000 }, (err, stdout, stderr) => {
      resolve({ ok: err === null, output: `${stdout}${stderr}`.trim() });
    });
  });
}

/** `owner/repo` → a GitHub URL; anything with a scheme or `@` is already a URL. */
export function gitUrl(source: string): string | undefined {
  if (/^(https?|git|ssh):\/\//.test(source) || source.startsWith('git@')) return source;
  // "./x", "../x", "/x" and "~/x" are paths, not GitHub shorthand
  if (/^[./~]/.test(source)) return undefined;
  if (/^[\w-][\w.-]*\/[\w-][\w.-]*$/.test(source)) return `https://github.com/${source}.git`;
  return undefined;
}

function readMarketplaceFile(dir: string): { file: MarketplaceFile } | { error: string } {
  for (const folder of ['.vinax-plugin', '.claude-plugin']) {
    const file = path.join(dir, folder, 'marketplace.json');
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = marketplaceFileSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
      if (parsed.success) return { file: parsed.data };
      return { error: `${file}: ${z.prettifyError(parsed.error).replace(/\n/g, '; ')}` };
    } catch (err) {
      return { error: `${file}: not valid JSON (${(err as Error).message})` };
    }
  }
  return {
    error: `${dir} has no .vinax-plugin/marketplace.json (or .claude-plugin/marketplace.json)`,
  };
}

/** The marketplace's catalog, as it is on disk now. */
export function readMarketplace(
  env: Env,
  name: string,
): { file: MarketplaceFile; dir: string } | { error: string } {
  const entry = readPluginConfig(env).marketplaces[name];
  if (entry === undefined) return { error: `No marketplace called "${name}".` };
  const read = readMarketplaceFile(entry.dir);
  return 'error' in read ? read : { file: read.file, dir: entry.dir };
}

/**
 * Adds a marketplace: a local folder (used where it is) or a git repository (cloned into
 * `~/.vinax/plugins/marketplaces/`). The name comes from the marketplace file, not the URL.
 */
export async function addMarketplace(
  env: Env,
  source: string,
): Promise<{ name: string; dir: string; plugins: MarketplaceEntry[] } | { error: string }> {
  const url = gitUrl(source);
  let dir: string;
  if (url === undefined) {
    dir = path.resolve(source);
    if (!fs.existsSync(dir)) return { error: `${dir} does not exist.` };
  } else {
    const slug = (url.split('/').pop() ?? 'marketplace').replace(/\.git$/, '');
    dir = path.join(pluginsDir(env), 'marketplaces', slug);
    await fsp.mkdir(path.dirname(dir), { recursive: true });
    await fsp.rm(dir, { recursive: true, force: true });
    const cloned = await git(['clone', '--depth', '1', url, dir], pluginsDir(env));
    if (!cloned.ok)
      return { error: `Could not clone ${url}: ${cloned.output.split('\n')[0] ?? ''}` };
  }
  const read = readMarketplaceFile(dir);
  if ('error' in read) return read;
  const config = readPluginConfig(env);
  config.marketplaces[read.file.name] = { source, dir };
  await writePluginConfig(env, config);
  return { name: read.file.name, dir, plugins: read.file.plugins };
}

/** Forgets a marketplace and uninstalls the plugins that came from it. */
export async function removeMarketplace(env: Env, name: string): Promise<{ removed: number }> {
  const config = readPluginConfig(env);
  Reflect.deleteProperty(config.marketplaces, name);
  let removed = 0;
  for (const [id, entry] of Object.entries(config.plugins)) {
    if (entry.marketplace !== name) continue;
    Reflect.deleteProperty(config.plugins, id);
    await fsp.rm(pluginDir(env, name, id.split('@')[0] ?? id), { recursive: true, force: true });
    removed++;
  }
  await writePluginConfig(env, config);
  return { removed };
}

/** `git pull` in a cloned marketplace (a local one is already current). */
export async function updateMarketplace(env: Env, name: string): Promise<{ error?: string }> {
  const entry = readPluginConfig(env).marketplaces[name];
  if (entry === undefined) return { error: `No marketplace called "${name}".` };
  if (gitUrl(entry.source) === undefined) return {};
  const pulled = await git(['pull', '--ff-only'], entry.dir);
  return pulled.ok ? {} : { error: pulled.output.split('\n')[0] ?? 'git pull failed' };
}

function entrySource(entry: MarketplaceEntry): string | undefined {
  if (typeof entry.source === 'string') return entry.source;
  if (typeof entry.source === 'object' && typeof entry.source.source === 'string')
    return entry.source.source;
  return undefined;
}

/**
 * Installs one plugin from a marketplace by copying (or cloning) it into
 * `~/.vinax/plugins/installed/`, so a later `git pull` of the marketplace cannot change what is
 * already running under you. Installing an already-installed plugin replaces it.
 */
export async function installPlugin(
  env: Env,
  name: string,
  marketplace: string,
): Promise<{ plugin: InstalledPlugin } | { error: string }> {
  const read = readMarketplace(env, marketplace);
  if ('error' in read) return read;
  const entry = read.file.plugins.find((p) => p.name === name);
  if (entry === undefined) return { error: `"${marketplace}" has no plugin called "${name}".` };
  const target = pluginDir(env, marketplace, name);
  await fsp.rm(target, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const source = entrySource(entry) ?? `./${name}`;
  const url = gitUrl(source);
  if (url === undefined) {
    const from = path.resolve(read.dir, source);
    if (!fs.existsSync(from)) return { error: `${from} is missing from the marketplace.` };
    await fsp.cp(from, target, { recursive: true });
  } else {
    const cloned = await git(['clone', '--depth', '1', url, target], pluginsDir(env));
    if (!cloned.ok)
      return { error: `Could not clone ${url}: ${cloned.output.split('\n')[0] ?? ''}` };
  }
  const manifest = readManifest(target);
  if (manifest === undefined) {
    await fsp.rm(target, { recursive: true, force: true });
    return {
      error: `${name} has no .vinax-plugin/plugin.json (or .claude-plugin/plugin.json) — it is not a plugin.`,
    };
  }
  const config = readPluginConfig(env);
  config.plugins[`${name}@${marketplace}`] = { marketplace, enabled: true };
  await writePluginConfig(env, config);
  return {
    plugin: {
      id: `${name}@${marketplace}`,
      name,
      marketplace,
      dir: target,
      enabled: true,
      manifest,
      missing: false,
    },
  };
}

export async function uninstallPlugin(env: Env, id: string): Promise<{ error?: string }> {
  const config = readPluginConfig(env);
  const entry = config.plugins[id];
  if (entry === undefined) return { error: `"${id}" is not installed.` };
  Reflect.deleteProperty(config.plugins, id);
  await writePluginConfig(env, config);
  await fsp.rm(pluginDir(env, entry.marketplace, id.split('@')[0] ?? id), {
    recursive: true,
    force: true,
  });
  return {};
}

/** Turns a plugin off without deleting it (its commands, agents, skills and hooks disappear). */
export async function setPluginEnabled(
  env: Env,
  id: string,
  enabled: boolean,
): Promise<{ error?: string }> {
  const config = readPluginConfig(env);
  const entry = config.plugins[id];
  if (entry === undefined) return { error: `"${id}" is not installed.` };
  config.plugins[id] = { ...entry, enabled };
  await writePluginConfig(env, config);
  return {};
}
