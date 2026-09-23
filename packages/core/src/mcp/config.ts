import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { vinaxHome, type Env } from '../config/paths.js';

const stdioServerSchema = z.strictObject({
  type: z.literal('stdio').optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
});
const remoteServerSchema = z.strictObject({
  /** `http` (streamable HTTP, default) or the older `sse` transport. */
  type: z.enum(['http', 'sse']).optional(),
  url: z.url(),
  headers: z.record(z.string(), z.string()).optional(),
});
export const mcpServerSchema = z.union([stdioServerSchema, remoteServerSchema]);
export type McpServerConfig = z.infer<typeof mcpServerSchema>;

const mcpFileSchema = z.strictObject({ mcpServers: z.record(z.string(), mcpServerSchema) });

export type McpScope = 'user' | 'project';

export interface McpServerEntry {
  name: string;
  scope: McpScope;
  config: McpServerConfig;
}

export function mcpConfigPath(scope: McpScope, cwd: string, env: Env): string {
  return scope === 'user'
    ? path.join(vinaxHome(env), 'mcp.json')
    : path.join(cwd, '.vinax', 'mcp.json');
}

async function readFile(
  file: string,
): Promise<{ servers: Record<string, McpServerConfig>; error?: string }> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return { servers: {} };
  }
  try {
    const parsed = mcpFileSchema.safeParse(JSON.parse(text));
    if (parsed.success) return { servers: parsed.data.mcpServers };
    return { servers: {}, error: `${file}: ${z.prettifyError(parsed.error).replace(/\n/g, '; ')}` };
  } catch (err) {
    return { servers: {}, error: `${file}: not valid JSON (${(err as Error).message})` };
  }
}

/** Servers from `~/.vinax/mcp.json` and `.vinax/mcp.json`; a project server overrides a user one. */
export async function loadMcpConfig(
  cwd: string,
  env: Env,
): Promise<{ servers: McpServerEntry[]; errors: string[] }> {
  const byName = new Map<string, McpServerEntry>();
  const errors: string[] = [];
  for (const scope of ['user', 'project'] as const) {
    const { servers, error } = await readFile(mcpConfigPath(scope, cwd, env));
    if (error !== undefined) errors.push(error);
    for (const [name, config] of Object.entries(servers)) byName.set(name, { name, scope, config });
  }
  return { servers: [...byName.values()], errors };
}

/** Adds or removes one server in a scope's mcp.json (validated before writing). */
export async function updateMcpConfig(
  scope: McpScope,
  cwd: string,
  env: Env,
  mutate: (servers: Record<string, McpServerConfig>) => Record<string, McpServerConfig>,
): Promise<string> {
  const file = mcpConfigPath(scope, cwd, env);
  const current = await readFile(file);
  if (current.error !== undefined) throw new Error(current.error);
  const next = mcpFileSchema.parse({ mcpServers: mutate({ ...current.servers }) });
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return file;
}

/** `${VAR}` and `${VAR:-default}` in args, env and header values come from the environment. */
export function expandEnvVars(value: string, env: Env): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_m, name: string, fallback: string | undefined) => env[name] ?? fallback ?? '',
  );
}
