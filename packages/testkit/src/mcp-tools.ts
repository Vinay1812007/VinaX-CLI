import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

/** A small MCP server with `echo`, `add` and `fail` tools, used by tests and demos. */
export function createDemoMcpServer(name = 'demo'): McpServer {
  const server = new McpServer({ name, version: '1.0.0' });
  server.registerTool(
    'echo',
    {
      description: 'Echo the text back',
      inputSchema: { text: z.string() },
      annotations: { readOnlyHint: true },
    },
    ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] }),
  );
  server.registerTool(
    'add',
    { description: 'Add two numbers', inputSchema: { a: z.number(), b: z.number() } },
    ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }),
  );
  server.registerTool('fail', { description: 'Always fails' }, () => ({
    content: [{ type: 'text', text: 'something broke' }],
    isError: true,
  }));
  return server;
}
