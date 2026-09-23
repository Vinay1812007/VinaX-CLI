import fs from 'node:fs/promises';
import path from 'node:path';
import { MCP_STDIO_SERVER } from '@vinax/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

describe('vinax mcp', () => {
  it('adds, lists (with a live check) and removes servers', async () => {
    h = await createHarness();
    const tsx = import.meta.resolve('tsx');
    const add = await h.run([
      'mcp',
      'add',
      'demo',
      '--',
      process.execPath,
      '--import',
      tsx,
      MCP_STDIO_SERVER,
    ]);
    expect(add.code).toBe(0);
    expect(add.stdout).toContain(`Added demo to ${path.join(h.home, 'mcp.json')}`);
    const cfg = JSON.parse(await fs.readFile(path.join(h.home, 'mcp.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(cfg.mcpServers.demo).toEqual({
      command: process.execPath,
      args: ['--import', tsx, MCP_STDIO_SERVER],
    });
    await h.run([
      'mcp',
      'add',
      'remote',
      'https://mcp.example.com/mcp',
      '--scope',
      'project',
      '-H',
      'Authorization: Bearer ${TOKEN}',
    ]);
    const project = JSON.parse(
      await fs.readFile(path.join(h.cwd, '.vinax', 'mcp.json'), 'utf8'),
    ) as { mcpServers: Record<string, unknown> };
    expect(project.mcpServers.remote).toEqual({
      type: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer ${TOKEN}' },
    });

    await h.run(['mcp', 'remove', 'remote', '--scope', 'project']);
    const list = await h.run(['mcp', 'list']);
    expect(list.stdout).toMatch(/demo\s+user\s+✔ 3 tools/);
    expect((await h.run(['mcp', 'remove', 'nope'])).code).toBe(1);
    expect((await h.run(['mcp', 'add', 'bad name', 'x'])).code).toBe(2);
  });
});
