import { Command, Option } from 'commander';
import {
  loadMcpConfig,
  McpManager,
  updateMcpConfig,
  type McpScope,
  type McpServerConfig,
} from '@vinax/core';
import { EXIT } from './exit-codes.js';
import { paint, type CliIO } from './io.js';
import { VERSION } from './version.js';

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function pairs(list: readonly string[], sep: string, what: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of list) {
    const i = item.indexOf(sep);
    if (i <= 0) throw new Error(`${what} must look like KEY${sep}VALUE: ${item}`);
    out[item.slice(0, i).trim()] = item.slice(i + 1).trim();
  }
  return out;
}

export function mcpCommand(io: CliIO, setExit: (code: number) => void): Command {
  const out = (s: string) => io.stdout.write(`${s}\n`);
  const err = (s: string) => io.stderr.write(`${s}\n`);
  const scopeOption = () =>
    new Option('--scope <scope>', 'user (~/.vinax/mcp.json) or project (.vinax/mcp.json)')
      .choices(['user', 'project'])
      .default('user');
  const cmd = new Command('mcp').description('Manage MCP servers');

  cmd
    .command('add <name> <commandOrUrl> [args...]')
    .description(
      'Add a server: an http(s) URL, or a command to start. Put commands after --, e.g. vinax mcp add fs -- npx -y some-mcp-server /path',
    )
    .addOption(scopeOption())
    .addOption(
      new Option('--transport <type>', 'for URLs: http (streamable HTTP) or sse')
        .choices(['http', 'sse'])
        .default('http'),
    )
    .option(
      '-e, --env <KEY=VALUE>',
      'environment variable for a stdio server (repeatable)',
      collect,
    )
    .option('-H, --header <Name: value>', 'HTTP header for a URL server (repeatable)', collect)
    .action(
      async (
        name: string,
        target: string,
        args: string[],
        o: { scope: McpScope; transport: 'http' | 'sse'; env?: string[]; header?: string[] },
      ) => {
        if (!/^[A-Za-z0-9_-]+$/.test(name)) {
          err('Server names may only use letters, digits, - and _.');
          setExit(EXIT.usage);
          return;
        }
        const isUrl = /^https?:\/\//.test(target);
        const config: McpServerConfig = isUrl
          ? {
              type: o.transport,
              url: target,
              ...(o.header ? { headers: pairs(o.header, ':', 'Headers') } : {}),
            }
          : {
              command: target,
              ...(args.length > 0 ? { args } : {}),
              ...(o.env ? { env: pairs(o.env, '=', 'Environment variables') } : {}),
            };
        const file = await updateMcpConfig(o.scope, io.cwd, io.env, (servers) => ({
          ...servers,
          [name]: config,
        }));
        out(`Added ${name} to ${file}.`);
        if (o.scope === 'project')
          out('Project servers must be approved once in VinaX (/mcp) before they start.');
      },
    );

  cmd
    .command('list')
    .description('List servers and check that they start')
    .action(async () => {
      const { servers, errors } = await loadMcpConfig(io.cwd, io.env);
      for (const e of errors) err(`⚠ ${e}`);
      if (servers.length === 0) {
        out('No MCP servers configured.');
        return;
      }
      const manager = new McpManager({ cwd: io.cwd, env: io.env, version: VERSION });
      await manager.start(servers, () => Promise.resolve(true));
      for (const s of manager.servers) {
        const target =
          'command' in s.config
            ? [s.config.command, ...(s.config.args ?? [])].join(' ')
            : s.config.url;
        const status =
          s.status === 'connected'
            ? paint(io.stdout, 'green', `✔ ${String(s.tools.length)} tools`, io.env)
            : paint(io.stdout, 'red', `✖ ${s.error ?? s.status}`, io.env);
        out(
          `${s.name.padEnd(16)} ${s.scope.padEnd(8)} ${status}  ${paint(io.stdout, 'dim', target, io.env)}`,
        );
      }
      await manager.close();
    });

  cmd
    .command('remove <name>')
    .description('Remove a server')
    .addOption(scopeOption())
    .action(async (name: string, o: { scope: McpScope }) => {
      const seen = { found: false };
      const file = await updateMcpConfig(o.scope, io.cwd, io.env, (servers) => {
        seen.found = name in servers;
        const next = { ...servers };
        Reflect.deleteProperty(next, name);
        return next;
      });
      if (!seen.found) {
        err(`No server named ${name} in ${file}.`);
        setExit(EXIT.error);
        return;
      }
      out(`Removed ${name} from ${file}.`);
    });
  return cmd;
}
