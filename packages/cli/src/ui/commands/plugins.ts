import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  addMarketplace,
  installPlugin,
  listPlugins,
  readMarketplace,
  readPluginConfig,
  removeMarketplace,
  setPluginEnabled,
  uninstallPlugin,
  updateMarketplace,
  type InstalledPlugin,
} from '@vinax/core';
import { shortenPath } from '../format.js';
import type { CommandContext, SlashCommand } from './types.js';

/** What a plugin adds, counted from its folder, so the list says what installing it did. */
function contributions(plugin: InstalledPlugin): string {
  const parts = [
    { dir: 'commands', label: 'commands' },
    { dir: 'agents', label: 'agents' },
    { dir: 'skills', label: 'skills' },
    { dir: 'hooks', label: 'hooks' },
  ];
  const found = parts.filter((p) => existsSync(join(plugin.dir, p.dir))).map((p) => p.label);
  if (existsSync(join(plugin.dir, '.mcp.json'))) found.push('MCP servers');
  return found.length === 0 ? 'nothing yet' : found.join(', ');
}

const RESTART =
  'Commands, agents, skills, hooks and MCP servers are read when a session starts, so run `/clear` (or restart VinaX) to pick the change up.';

function overview(ctx: CommandContext): string {
  const config = readPluginConfig(ctx.runtime.env);
  const plugins = listPlugins(ctx.runtime.env);
  const markets = Object.entries(config.marketplaces);
  const lines: string[] = [];
  lines.push('**Marketplaces**', '');
  if (markets.length === 0) lines.push('None yet. Add one with `/plugin marketplace add <repo>`.');
  for (const [name, entry] of markets) {
    const read = readMarketplace(ctx.runtime.env, name);
    lines.push(
      `- **${name}** — ${'error' in read ? read.error : `${String(read.file.plugins.length)} plugins`}\n  \`${shortenPath(entry.dir)}\``,
    );
  }
  lines.push('', '**Installed plugins**', '');
  if (plugins.length === 0)
    lines.push('None yet. Add a marketplace, then `/plugin install <name>@<marketplace>`.');
  for (const p of plugins) {
    const state = p.missing ? '✖ missing on disk' : p.enabled ? '✔ enabled' : '○ disabled';
    lines.push(
      `- ${state} **${p.id}**${p.manifest.version === undefined ? '' : ` v${p.manifest.version}`} — ${p.manifest.description ?? 'no description'}`,
      `  adds: ${p.missing ? 'unknown' : contributions(p)}`,
    );
  }
  lines.push(
    '',
    '`/plugin marketplace add|remove|update <name>` · `/plugin install <name>@<marketplace>` · `/plugin enable|disable|uninstall <name>@<marketplace>`',
    '',
    RESTART,
  );
  return lines.join('\n');
}

async function marketplaceCommand(ctx: CommandContext, rest: string): Promise<void> {
  const [action = '', ...argv] = rest.split(/\s+/).filter((s) => s !== '');
  const arg = argv.join(' ');
  const env = ctx.runtime.env;
  if (action === 'add') {
    if (arg === '') {
      ctx.notice('error', 'Give a marketplace: a GitHub `owner/repo`, a git URL or a local path.');
      return;
    }
    const added = await ctx.busy(`Adding ${arg}`, () => addMarketplace(env, arg));
    if (added === undefined) return;
    if ('error' in added) {
      ctx.notice('error', added.error);
      return;
    }
    ctx.panel(
      `Marketplace ${added.name}`,
      [
        `Added from \`${arg}\`.`,
        '',
        ...added.plugins.map(
          (p) =>
            `- **${p.name}** — ${p.description ?? 'no description'}  \n  \`/plugin install ${p.name}@${added.name}\``,
        ),
      ].join('\n'),
    );
    return;
  }
  if (action === 'remove') {
    const { removed } = await removeMarketplace(env, arg);
    ctx.notice(
      'info',
      `Removed the "${arg}" marketplace${removed === 0 ? '' : ` and uninstalled ${String(removed)} plugin${removed === 1 ? '' : 's'} from it`}. ${RESTART}`,
    );
    return;
  }
  if (action === 'update') {
    const names = arg === '' ? Object.keys(readPluginConfig(env).marketplaces) : [arg];
    for (const name of names) {
      const result = await ctx.busy(`Updating ${name}`, () => updateMarketplace(env, name));
      if (result?.error !== undefined) ctx.notice('warning', `${name}: ${result.error}`);
    }
    ctx.notice(
      'info',
      names.length === 0
        ? 'No marketplaces to update.'
        : `Updated ${names.join(', ')}. Reinstall a plugin to take its new version: /plugin install <name>@<marketplace>.`,
    );
    return;
  }
  ctx.notice('error', 'Use /plugin marketplace add|remove|update <name or repo>.');
}

/** `name@marketplace`, or just `name` when only one marketplace has it. */
function resolveId(ctx: CommandContext, arg: string): string | { error: string } {
  if (arg.includes('@')) return arg;
  const matches = listPlugins(ctx.runtime.env).filter((p) => p.name === arg);
  if (matches.length === 1 && matches[0]) return matches[0].id;
  if (matches.length === 0) return { error: `"${arg}" is not installed.` };
  return {
    error: `Several marketplaces have "${arg}": ${matches.map((m) => m.id).join(', ')}. Name one.`,
  };
}

export const plugin: SlashCommand = {
  name: 'plugin',
  argumentHint:
    '[marketplace add <repo> | install <name>@<marketplace> | enable|disable|uninstall]',
  description: 'Plugins: marketplaces, install, enable, disable and uninstall',
  source: 'builtin',
  async run(ctx) {
    const env = ctx.runtime.env;
    const args = ctx.args.trim();
    const [verb = '', ...argv] = args.split(/\s+/).filter((s) => s !== '');
    const arg = argv.join(' ');
    switch (verb) {
      case '':
      case 'list':
        ctx.panel('Plugins', overview(ctx));
        return;
      case 'marketplace':
      case 'marketplaces':
        await marketplaceCommand(ctx, arg);
        return;
      case 'install': {
        const at = arg.lastIndexOf('@');
        const markets = Object.keys(readPluginConfig(env).marketplaces);
        const name = at === -1 ? arg : arg.slice(0, at);
        const marketplace =
          at === -1 ? (markets.length === 1 ? (markets[0] ?? '') : '') : arg.slice(at + 1);
        if (name === '' || marketplace === '') {
          ctx.notice(
            'error',
            markets.length === 0
              ? 'Add a marketplace first: /plugin marketplace add <owner/repo>.'
              : `Use /plugin install <name>@<marketplace>. Marketplaces: ${markets.join(', ')}.`,
          );
          return;
        }
        const result = await ctx.busy(`Installing ${name}`, () =>
          installPlugin(env, name, marketplace),
        );
        if (result === undefined) return;
        if ('error' in result) {
          ctx.notice('error', result.error);
          return;
        }
        ctx.notice(
          'info',
          `Installed ${result.plugin.id} — it adds ${contributions(result.plugin)}. ${RESTART}`,
        );
        return;
      }
      case 'enable':
      case 'disable': {
        const id = resolveId(ctx, arg);
        if (typeof id !== 'string') {
          ctx.notice('error', id.error);
          return;
        }
        const result = await setPluginEnabled(env, id, verb === 'enable');
        if (result.error !== undefined) {
          ctx.notice('error', result.error);
          return;
        }
        ctx.notice('info', `${verb === 'enable' ? 'Enabled' : 'Disabled'} ${id}. ${RESTART}`);
        return;
      }
      case 'uninstall':
      case 'remove': {
        const id = resolveId(ctx, arg);
        if (typeof id !== 'string') {
          ctx.notice('error', id.error);
          return;
        }
        const result = await uninstallPlugin(env, id);
        if (result.error !== undefined) {
          ctx.notice('error', result.error);
          return;
        }
        ctx.notice('info', `Uninstalled ${id}. ${RESTART}`);
        return;
      }
      default:
        ctx.notice(
          'error',
          `Unknown /plugin action "${verb}". Use list, marketplace, install, enable, disable or uninstall.`,
        );
    }
  },
};
