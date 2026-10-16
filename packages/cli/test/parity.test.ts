import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cliSettings, type SessionOptions } from '../src/session-options.js';
import { reviewPrompt } from '../src/ui/commands/workspace.js';
import { createHarness, type Harness } from './helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const tc = (name: string, args: Record<string, unknown>) => ({
  name,
  arguments: JSON.stringify(args),
});

const toolMessages = (hh: Harness) =>
  (
    hh.groq.requests.at(-1)?.body as { messages: { role: string; content: string }[] }
  ).messages.filter((m) => m.role === 'tool');

describe('approval-mode flags', () => {
  it('--read-only refuses edits and writing commands but runs read-only ones', async () => {
    h = await createHarness({
      groq: {
        script: {
          'main-model': [
            {
              toolCalls: [
                tc('Write', { file_path: 'out.txt', content: 'hi\n' }),
                tc('Bash', { command: 'touch made.txt' }),
                tc('Bash', { command: 'pwd' }),
              ],
            },
            { text: 'Done.' },
          ],
        },
      },
    });
    const r = await h.run(['-p', 'go', '--read-only']);
    expect(r.code).toBe(0);
    const tools = toolMessages(h).map((m) => m.content);
    expect(tools[0]).toContain('Read-only mode is on');
    expect(tools[1]).toContain('Read-only mode is on');
    expect(tools[2]).toContain(path.basename(h.cwd));
    await expect(fs.access(path.join(h.cwd, 'out.txt'))).rejects.toThrow();
    await expect(fs.access(path.join(h.cwd, 'made.txt'))).rejects.toThrow();
  });

  it('--yolo runs everything without asking and warns loudly', async () => {
    h = await createHarness({
      groq: {
        script: {
          'main-model': [
            {
              toolCalls: [
                tc('Bash', { command: 'echo from-yolo' }),
                tc('Write', { file_path: 'out.txt', content: 'hi\n' }),
              ],
            },
            { text: 'Done.' },
          ],
        },
      },
    });
    const r = await h.run(['-p', 'go', '--yolo']);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('Bypass mode is on');
    expect(toolMessages(h).map((m) => m.content)).toEqual([
      'from-yolo',
      'Created out.txt (1 lines).',
    ]);
  });

  it('rejects two different modes and unknown sandbox modes', async () => {
    h = await createHarness({});
    const both = await h.run(['-p', 'x', '--yolo', '--read-only']);
    expect(both.code).toBe(2);
    expect(both.stderr).toContain('choose one permission mode');
    expect((await h.run(['-p', 'x', '--sandbox', 'nope'])).code).toBe(2);
    // --yolo with a different --permission-mode is a mistake too
    const same = await h.run(['--yolo', '--permission-mode', 'acceptEdits', '-p', 'x']);
    expect(same.code).toBe(2);
  });

  it('turns --sandbox into a settings layer', () => {
    const base: SessionOptions = {
      prompt: undefined,
      model: undefined,
      verbose: false,
      permissionMode: 'readOnly',
      allowedTools: [],
      disallowedTools: [],
      addDirs: [],
      maxTurns: undefined,
      continueLast: false,
      resume: undefined,
    };
    expect(cliSettings({ ...base, sandbox: 'workspace-write' })).toEqual({
      sandbox: 'workspace-write',
      permissions: { defaultMode: 'readOnly' },
    });
  });
});

describe('/review prompt', () => {
  it('targets uncommitted changes, a pull request or a branch', () => {
    expect(reviewPrompt('')).toContain('Review my uncommitted changes');
    expect(reviewPrompt('#42')).toContain('gh pr diff 42');
    expect(reviewPrompt('feature/x')).toContain('`feature/x`');
    expect(reviewPrompt('')).toContain('Do not change any files');
  });
});
