import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppStateStore } from '@vinax/core';
import {
  bandFor,
  LOGO_GRID,
  LOGO_HEIGHT,
  LOGO_MIN_WIDTH,
  LOGO_WIDTH,
  logoSegments,
} from '../../src/ui/brand.js';
import {
  checkForUpdate,
  releaseNotes,
  startupAnnouncements,
  updateCheckDisabled,
} from '../../src/updates.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});
async function tmp(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'vinax-lus-'));
  dirs.push(d);
  return d;
}

describe('VinaX logo', () => {
  it('spells VinaX in seven striped rows with a chakra in the a', () => {
    expect(LOGO_GRID).toHaveLength(LOGO_HEIGHT);
    expect(LOGO_WIDTH).toBe(47);
    expect(LOGO_MIN_WIDTH).toBe(51);
    expect(LOGO_GRID.join('\n').match(/o/g)).toHaveLength(1);
    expect([0, 1, 2, 3, 4, 5, 6].map(bandFor)).toEqual([
      'saffron',
      'saffron',
      'saffron',
      'white',
      'white',
      'green',
      'green',
    ]);
  });

  it('turns a row into fill, chakra and space runs, with an ASCII fallback', () => {
    expect(logoSegments('## o #')).toEqual([
      { text: '▀▀', kind: 'fill' },
      { text: ' ', kind: 'space' },
      { text: '✺', kind: 'chakra' },
      { text: ' ', kind: 'space' },
      { text: '▀', kind: 'fill' },
    ]);
    expect(logoSegments('#o', true).map((s) => s.text)).toEqual(['=', 'o']);
  });
});

describe('update notices', () => {
  const release = (tag: string) =>
    vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ tag_name: tag, assets: [] }), { status: 200 })),
    );

  it('reports a newer release once a day, from cache in between', async () => {
    const home = await tmp();
    const env = { VINAX_HOME: home };
    let t = 1_000_000;
    const fetchFn = release('v0.3.0');
    expect(
      await checkForUpdate({
        current: '0.2.1',
        env,
        now: () => t,
        fetchFn: fetchFn,
      }),
    ).toBe('0.3.0');
    t += 60_000;
    expect(
      await checkForUpdate({
        current: '0.2.1',
        env,
        now: () => t,
        fetchFn: fetchFn,
      }),
    ).toBe('0.3.0');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(
      await checkForUpdate({
        current: '0.3.0',
        env,
        now: () => t,
        fetchFn: fetchFn,
      }),
    ).toBeUndefined();
  });

  it('stays quiet in CI, when disabled, and when the network fails', async () => {
    expect(updateCheckDisabled({ CI: 'true' })).toBe(true);
    expect(updateCheckDisabled({ VINAX_NO_UPDATE_CHECK: '1' })).toBe(true);
    expect(updateCheckDisabled({ VINAX_NO_UPDATE_CHECK: '0' })).toBe(false);
    const failing = vi.fn(() => Promise.reject(new Error('offline')));
    expect(
      await checkForUpdate({
        current: '0.2.1',
        env: { VINAX_HOME: await tmp() },
        fetchFn: failing,
      }),
    ).toBeUndefined();
  });

  const CHANGELOG = [
    '# @sirimillavinay/vinax',
    '',
    '## 0.3.0',
    '',
    '### Minor Changes',
    '',
    '- abc1234: Snake and a new logo.',
    '',
    '  - **Snake:** `/snake` in colour.',
    '',
    '## 0.2.1',
    '',
    '### Patch Changes',
    '',
    '- 9ce31b5: Clearer gateway message.',
    '',
    '## 0.2.0',
    '',
    '- 956a802: NVIDIA.',
  ].join('\n');

  it('extracts release notes between two versions, newest first', () => {
    expect(releaseNotes(CHANGELOG, '0.2.0', '0.3.0')).toEqual([
      {
        version: '0.3.0',
        bullets: ['- Snake and a new logo.', '  - **Snake:** `/snake` in colour.'],
      },
      { version: '0.2.1', bullets: ['- Clearer gateway message.'] },
    ]);
    expect(releaseNotes(CHANGELOG, undefined, '0.2.1', 1)).toEqual([
      { version: '0.2.1', bullets: ['- Clearer gateway message.'] },
    ]);
  });

  it("shows what's new once after an upgrade and records the version", async () => {
    const home = await tmp();
    const env = { VINAX_HOME: home, VINAX_NO_UPDATE_CHECK: '1' };
    const changelog = () => Promise.resolve(CHANGELOG);
    // first run ever: nothing to announce, just remember the version
    expect(await startupAnnouncements({ current: '0.2.0', env, changelog })).toEqual([]);
    const after = await startupAnnouncements({ current: '0.3.0', env, changelog });
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ kind: 'panel', title: 'VinaX updated: v0.2.0 → v0.3.0' });
    expect(after[0]?.kind === 'panel' ? after[0].markdown : '').toContain('Snake and a new logo.');
    expect((await new AppStateStore(env).read()).lastVersion).toBe('0.3.0');
    expect(await startupAnnouncements({ current: '0.3.0', env, changelog })).toEqual([]);
  });

  it('announces an available update', async () => {
    const env = { VINAX_HOME: await tmp(), VINAX_UPDATE_URL: 'http://example.invalid/latest' };
    const list = await startupAnnouncements({
      current: '0.2.1',
      env,
      fetchFn: release('v0.3.0'),
    });
    expect(list).toEqual([
      {
        kind: 'notice',
        level: 'warning',
        text: 'Update available: v0.2.1 → v0.3.0. Run `vinax update` (or /update for details).',
      },
    ]);
  });
});
