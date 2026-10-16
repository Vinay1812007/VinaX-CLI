import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Runtime } from '@vinax/core';
import { afterEach, describe, expect, it } from 'vitest';
import { findCommand, loadCommands } from '../src/ui/commands/registry.js';
import { cliSettings, type SessionOptions } from '../src/session-options.js';
import {
  prCommentsPrompt,
  reviewPrompt,
  securityReviewPrompt,
} from '../src/ui/commands/workspace.js';
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

  it('maps Gemini CLI --approval-mode names', async () => {
    h = await createHarness({
      groq: {
        script: {
          'main-model': [
            { toolCalls: [tc('Write', { file_path: 'out.txt', content: 'hi\n' })] },
            { text: 'Done.' },
          ],
        },
      },
    });
    const r = await h.run(['-p', 'go', '--approval-mode', 'auto_edit']);
    expect(r.code).toBe(0);
    expect(await fs.readFile(path.join(h.cwd, 'out.txt'), 'utf8')).toBe('hi\n');
    expect((await h.run(['-p', 'x', '--approval-mode', 'yolo', '--read-only'])).code).toBe(2);
    expect((await h.run(['-p', 'x', '--approval-mode', 'sometimes'])).code).toBe(2);
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

describe('command registry', () => {
  it('lets custom commands replace overridable built-ins and take aliases, but not core ones', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vinax-reg-')));
    try {
      const dir = path.join(root, 'project', '.vinax', 'commands');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'review.md'), '---\ndescription: My review\n---\nReview.');
      await fs.writeFile(path.join(dir, 'help.md'), '---\ndescription: My help\n---\nHelp.');
      await fs.writeFile(path.join(dir, 'diff.md'), '---\ndescription: My diff\n---\nDiff.');
      const runtime = {
        cwd: path.join(root, 'project'),
        env: { VINAX_HOME: path.join(root, 'home') },
      } as unknown as Runtime;
      const { commands, warnings } = await loadCommands(runtime);
      expect(findCommand(commands, 'review')?.source).toBe('project');
      expect(commands.filter((c) => c.name === 'review')).toHaveLength(1);
      expect(findCommand(commands, 'help')?.source).toBe('builtin');
      expect(warnings.some((w) => w.includes('/help'))).toBe(true);
      // an exact name wins over a built-in's alias
      expect(findCommand(commands, 'diff')?.source).toBe('project');
      expect(findCommand(commands, 'compress')?.name).toBe('compact');
      expect(findCommand(commands, 'add-dir')?.name).toBe('directory');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('review prompts', () => {
  it('asks for a security review and for PR comments', () => {
    expect(securityReviewPrompt('')).toContain('security review of my uncommitted changes');
    expect(securityReviewPrompt('src/auth')).toContain('`src/auth`');
    expect(prCommentsPrompt('12')).toContain('`gh pr view 12 --comments`');
    expect(prCommentsPrompt('')).toContain('`gh pr view --comments`');
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
