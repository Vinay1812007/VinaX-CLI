import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileIndex } from '../src/index.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function tree(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vinax-fi-'));
  dirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), text);
  }
  return root;
}

describe('FileIndex', () => {
  it('skips noise folders, .gitignore rules and bundles, and marks folders', async () => {
    const root = await tree({
      'src/app.ts': 'x',
      'src/util/strings.ts': 'x',
      'node_modules/pkg/index.js': 'x',
      'Library/Caches/big.bin': 'x',
      'dist/app.js': 'x',
      'secret/app.env': 'x',
      'Tool.app/Contents/Info.plist': 'x',
      '.gitignore': 'secret/\n',
    });
    execFileSync('git', ['init', '-q'], { cwd: root });
    const paths = await new FileIndex(root).list();
    expect(paths).toEqual(
      expect.arrayContaining([
        'src/',
        'src/app.ts',
        'src/util/',
        'src/util/strings.ts',
        'Tool.app/',
      ]),
    );
    for (const p of paths)
      expect(p).not.toMatch(/^(node_modules|Library|dist|secret|\.git)\/|Tool\.app\/Contents/);
    // breadth-first: shallow paths come first
    expect(paths.indexOf('src/')).toBeLessThan(paths.indexOf('src/util/strings.ts'));
  });

  it('lists the top level for an empty query, folders first, hidden files left out', async () => {
    const root = await tree({
      'b.txt': 'x',
      'a.md': 'x',
      'src/app.ts': 'x',
      '.env': 'x',
      'Library/x': 'x',
    });
    const r = await new FileIndex(root).suggest('');
    expect(r.entries.map((e) => e.path)).toEqual(['Library/', 'src/', 'a.md', 'b.txt']);
    expect(r.entries[1]).toEqual({ path: 'src/', dir: true });
    expect(r.more).toBe(false);
    expect((await new FileIndex(root).suggest('.')).entries.map((e) => e.path)).toContain('.env');
  });

  it('drills into a folder with `dir/` and filters its children', async () => {
    const root = await tree({
      'src/app.ts': 'x',
      'src/api/client.ts': 'x',
      'src/zeta.ts': 'x',
    });
    const index = new FileIndex(root);
    expect((await index.suggest('src/')).entries.map((e) => e.path)).toEqual([
      'src/api/',
      'src/app.ts',
      'src/zeta.ts',
    ]);
    expect((await index.suggest('src/ap')).entries.map((e) => e.path)).toEqual([
      'src/api/',
      'src/app.ts',
    ]);
    expect((await index.suggest('src/api/')).entries.map((e) => e.path)).toEqual([
      'src/api/client.ts',
    ]);
    // folders outside the project are not listed
    expect((await index.suggest('../')).entries).toEqual([]);
  });

  it('ranks fuzzy matches by file name, hidden paths last', async () => {
    const root = await tree({
      'docs/app-notes.md': 'x',
      'src/app.ts': 'x',
      'src/utils/mapper.ts': 'x',
      '.cfg/app.json': 'x',
      'src/.DS_Store': 'x',
    });
    const index = new FileIndex(root);
    const r = await index.suggest('app');
    expect(r.entries[0]?.path).toBe('src/app.ts');
    expect(r.entries.map((e) => e.path)).toContain('docs/app-notes.md');
    const order = r.entries.map((e) => e.path);
    expect(order.indexOf('.cfg/app.json')).toBeGreaterThan(order.indexOf('docs/app-notes.md'));
    expect((await index.suggest('.cfg')).entries[0]?.path).toBe('.cfg/');
    expect(await index.list()).not.toContain('src/.DS_Store');
  });

  it('stays bounded in a huge folder and reports partial results', async () => {
    const files: Record<string, string> = {};
    for (let d = 0; d < 40; d++)
      for (let f = 0; f < 60; f++) files[`dir${String(d)}/file${String(f)}.txt`] = '';
    const root = await tree(files);
    const index = new FileIndex(root, { maxEntries: 500 });
    const started = Date.now();
    const paths = await index.list();
    expect(Date.now() - started).toBeLessThan(3000);
    expect(paths.length).toBe(500);
    // all 40 top-level folders are indexed before any deeper file
    expect(paths.slice(0, 40).every((p) => p.endsWith('/'))).toBe(true);
    const r = await index.suggest('file1');
    expect(r.entries).toHaveLength(10);
    expect(r.more).toBe(true);
  });

  it('answers quickly while the index is still building', async () => {
    const files: Record<string, string> = {};
    for (let d = 0; d < 30; d++)
      for (let f = 0; f < 30; f++) files[`d${String(d)}/sub/f${String(f)}.txt`] = '';
    const root = await tree(files);
    const index = new FileIndex(root, { waitMs: 0 });
    const started = Date.now();
    const top = await index.suggest('');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(top.entries).toHaveLength(10);
    expect(top.more).toBe(true);
    await index.ready();
    expect((await index.suggest('f29')).entries.length).toBeGreaterThan(0);
  });
});
