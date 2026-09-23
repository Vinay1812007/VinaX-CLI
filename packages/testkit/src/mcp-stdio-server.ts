// Run with: node --import tsx packages/testkit/src/mcp-stdio-server.ts
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createDemoMcpServer } from './mcp-tools.js';

await createDemoMcpServer(process.argv[2] ?? 'demo').connect(new StdioServerTransport());
