import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import type { Env } from '../config/paths.js';
import { resolvePath } from '../tools/paths.js';
import { truncateMiddle } from '../tools/truncate.js';
import { defineTool, type AnyTool } from '../tools/types.js';
import { expandEnvVars, type McpServerConfig, type McpServerEntry } from './config.js';

const CONNECT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 120_000;

export type McpStatus = 'connected' | 'failed' | 'needs-approval' | 'connecting';

export interface McpServerState {
  name: string;
  scope: McpServerEntry['scope'];
  status: McpStatus;
  error?: string;
  tools: AnyTool[];
  config: McpServerConfig;
}

/** `mcp__<server>__<tool>`, limited to characters and length providers accept for tool names. */
export function mcpToolName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_');
  return `mcp__${clean(server)}__${clean(tool)}`.slice(0, 64);
}

interface McpContent {
  type: string;
  text?: string;
  resource?: { text?: string; uri?: string };
}

function contentText(content: readonly McpContent[]): string {
  return content
    .map((c) => {
      if (c.type === 'text') return c.text ?? '';
      if (c.type === 'resource') return c.resource?.text ?? `[resource ${c.resource?.uri ?? ''}]`;
      return `[${c.type} content omitted]`;
    })
    .join('\n');
}

function transportFor(config: McpServerConfig, env: Env, cwd: string): Transport {
  if ('command' in config) {
    return new StdioClientTransport({
      command: expandEnvVars(config.command, env),
      args: (config.args ?? []).map((a) => expandEnvVars(a, env)),
      env: {
        ...Object.fromEntries(
          Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined),
        ),
        ...Object.fromEntries(
          Object.entries(config.env ?? {}).map(([k, v]) => [k, expandEnvVars(v, env)]),
        ),
      },
      cwd: config.cwd === undefined ? cwd : resolvePath(config.cwd, cwd),
      stderr: 'ignore',
    });
  }
  const url = new URL(expandEnvVars(config.url, env));
  const headers = Object.fromEntries(
    Object.entries(config.headers ?? {}).map(([k, v]) => [k, expandEnvVars(v, env)]),
  );
  return config.type === 'sse'
    ? // the older SSE transport is still what some servers speak; `type: "sse"` opts into it
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      new SSEClientTransport(url, { requestInit: { headers } })
    : new StreamableHTTPClientTransport(url, { requestInit: { headers } });
}

function adaptTool(
  server: string,
  client: Client,
  t: {
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
    annotations?: { readOnlyHint?: boolean };
  },
): AnyTool {
  const name = mcpToolName(server, t.name);
  return defineTool({
    name,
    description: `${t.description ?? t.name} (MCP server "${server}")`,
    input: z.looseObject({}),
    jsonSchema: { type: 'object', ...t.inputSchema },
    kind: 'network',
    readOnly: t.annotations?.readOnlyHint === true,
    label: (i) => {
      const first = Object.values(i).find((v) => typeof v === 'string');
      return typeof first === 'string' ? first.slice(0, 80) : '';
    },
    target: () => ({}),
    async run(input, ctx) {
      const result = await client.callTool({ name: t.name, arguments: input }, undefined, {
        signal: ctx.signal,
        timeout: CALL_TIMEOUT_MS,
      });
      const content = Array.isArray(result.content) ? (result.content as McpContent[]) : [];
      const text = contentText(content).trim();
      const ok = result.isError !== true;
      const lines = text === '' ? 0 : text.split('\n').length;
      return {
        ok,
        content: truncateMiddle(text === '' ? '(no output)' : text),
        summary: `${ok ? 'Done' : 'Error'} · ${String(lines)} line${lines === 1 ? '' : 's'}`,
      };
    },
  });
}

/** Connects to configured MCP servers and exposes their tools as VinaX tools. */
export class McpManager {
  readonly servers: McpServerState[] = [];
  private readonly clients = new Map<string, Client>();

  constructor(private readonly opts: { cwd: string; env: Env; version: string }) {}

  /** Starts every server; project servers the user has not approved are left waiting. */
  async start(
    entries: readonly McpServerEntry[],
    approved: (entry: McpServerEntry) => Promise<boolean>,
  ): Promise<void> {
    await Promise.all(
      entries.map(async (entry) => {
        const state: McpServerState = {
          name: entry.name,
          scope: entry.scope,
          status: 'connecting',
          tools: [],
          config: entry.config,
        };
        this.servers.push(state);
        if (!(await approved(entry))) {
          state.status = 'needs-approval';
          return;
        }
        await this.connect(state);
      }),
    );
  }

  /** Connects one server (also used after approving it with /mcp). */
  async connect(state: McpServerState): Promise<void> {
    state.status = 'connecting';
    const client = new Client({ name: 'vinax', version: this.opts.version });
    try {
      await client.connect(transportFor(state.config, this.opts.env, this.opts.cwd), {
        timeout: CONNECT_TIMEOUT_MS,
      });
      const listed = await client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS });
      state.tools = listed.tools.map((t) =>
        adaptTool(state.name, client, t as Parameters<typeof adaptTool>[2]),
      );
      state.status = 'connected';
      delete state.error;
      this.clients.set(state.name, client);
    } catch (err) {
      state.status = 'failed';
      state.error = err instanceof Error ? err.message : String(err);
      await client.close().catch(() => undefined);
    }
  }

  tools(): AnyTool[] {
    return this.servers.flatMap((s) => s.tools);
  }

  async close(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.close().catch(() => undefined)));
    this.clients.clear();
  }
}
