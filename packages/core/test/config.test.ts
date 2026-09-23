import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  mergeSettings,
  parseSettings,
  SettingsError,
  updateSettingsFile,
} from '../src/index.js';

let tmp: string;
let home: string;
let cwd: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vinax-config-'));
  home = path.join(tmp, 'home');
  cwd = path.join(tmp, 'project');
  await fs.mkdir(path.join(cwd, '.vinax'), { recursive: true });
  await fs.mkdir(home, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const write = (file: string, data: unknown): Promise<void> =>
  fs.writeFile(file, JSON.stringify(data), 'utf8');

describe('parseSettings', () => {
  it('turns unknown keys into warnings and keeps the rest', () => {
    const { settings, warnings } = parseSettings(
      { model: 'groq:a', providers: { groq: { rpm: 5, colour: 'red' } }, bogus: 1 },
      'test.json',
    );
    expect(settings).toEqual({ model: 'groq:a', providers: { groq: { rpm: 5 } } });
    expect(warnings).toEqual([
      'Unknown setting "bogus" in test.json (ignored)',
      'Unknown setting "providers.groq.colour" in test.json (ignored)',
    ]);
  });

  it('names the offending key for invalid values', () => {
    expect(() => parseSettings({ model: 'gpt-4', router: { maxRetries: -1 } }, 'x.json')).toThrow(
      SettingsError,
    );
    try {
      parseSettings({ model: 'gpt-4' }, 'x.json');
    } catch (err) {
      expect((err as Error).message).toContain('Invalid settings in x.json');
      expect((err as Error).message).toContain('model: expected "<provider>:<model-id>"');
    }
  });
});

describe('mergeSettings', () => {
  it('lets later layers win and accumulates permission rules', () => {
    const merged = mergeSettings([
      { model: 'groq:a', permissions: { allow: ['Read'], deny: ['Bash(rm *)'] } },
      { model: 'groq:b', permissions: { allow: ['Read', 'Edit(src/**)'] } },
      { fallbackChain: ['openrouter:c'], providers: { groq: { rpm: 10 } } },
      { providers: { groq: { enabled: false } } },
    ]);
    expect(merged).toEqual({
      model: 'groq:b',
      fallbackChain: ['openrouter:c'],
      providers: { groq: { rpm: 10, enabled: false } },
      permissions: { allow: ['Read', 'Edit(src/**)'], deny: ['Bash(rm *)'] },
    });
  });
});

describe('loadSettings', () => {
  it('applies user < project < local < cli precedence over defaults', async () => {
    const env = { VINAX_HOME: home };
    await write(path.join(home, 'settings.json'), { model: 'groq:user', smallModel: 'groq:small' });
    await write(path.join(cwd, '.vinax', 'settings.json'), { model: 'groq:project' });
    await write(path.join(cwd, '.vinax', 'settings.local.json'), {
      model: 'groq:local',
      router: { maxRetries: 5 },
    });
    const loaded = await loadSettings({ cwd, env, cli: { model: 'openrouter:cli' } });
    expect(loaded.resolved.model).toBe('openrouter:cli');
    expect(loaded.resolved.smallModel).toBe('groq:small');
    expect(loaded.resolved.router.maxRetries).toBe(5);
    expect(loaded.resolved.router.baseDelayMs).toBe(DEFAULT_SETTINGS.router.baseDelayMs);
    expect(loaded.layers.map((l) => l.source)).toEqual(['user', 'project', 'local', 'cli']);
  });

  it('reports invalid JSON with the file name', async () => {
    await fs.writeFile(path.join(cwd, '.vinax', 'settings.json'), '{ nope', 'utf8');
    await expect(loadSettings({ cwd, env: { VINAX_HOME: home } })).rejects.toThrow(
      /settings\.json[\s\S]*not valid JSON/,
    );
  });
});

describe('updateSettingsFile', () => {
  it('refuses to write an invalid value', async () => {
    await expect(
      updateSettingsFile({ cwd, env: { VINAX_HOME: home }, scope: 'user' }, (s) => ({
        ...s,
        model: 'nope',
      })),
    ).rejects.toThrow(SettingsError);
  });

  it('adds the local settings file to .gitignore in a git repo', async () => {
    execFileSync('git', ['init', '-q'], { cwd });
    await updateSettingsFile({ cwd, env: { VINAX_HOME: home }, scope: 'local' }, (s) => ({
      ...s,
      model: 'groq:x',
    }));
    const gitignore = await fs.readFile(path.join(cwd, '.gitignore'), 'utf8');
    expect(gitignore).toContain('.vinax/settings.local.json');
    // idempotent
    await updateSettingsFile({ cwd, env: { VINAX_HOME: home }, scope: 'local' }, (s) => s);
    const again = await fs.readFile(path.join(cwd, '.gitignore'), 'utf8');
    expect(again.match(/settings\.local\.json/g)).toHaveLength(1);
  });
});
