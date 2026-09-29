import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { FileIndex } from '@vinax/core';
import { Suggestions } from '../../src/ui/components/Suggestions.js';
import { resolveTheme, ThemeContext } from '../../src/ui/theme.js';
import { completionToken, useSuggestions } from '../../src/ui/use-suggestions.js';

const mono = resolveTheme('dark', { NO_COLOR: '1' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dirs: string[] = [];
let app: ReturnType<typeof render> | undefined;
afterEach(async () => {
  app?.unmount();
  app = undefined;
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function tree(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vinax-sug-'));
  dirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), text);
  }
  return root;
}

function Harness({ value, files }: { value: string; files: FileIndex }) {
  const s = useSuggestions({ value, cursor: value.length }, [], files);
  return (
    <>
      <Suggestions items={s.items} index={s.index} width={80} />
      <Text>{s.items.map((i) => `${i.text}|${i.kind ?? ''}`).join(',')}</Text>
    </>
  );
}

async function show(value: string, files: FileIndex, until: string): Promise<() => string> {
  app = render(
    <ThemeContext.Provider value={mono}>
      <Harness value={value} files={files} />
    </ThemeContext.Provider>,
  );
  const frame = () => app?.lastFrame() ?? '';
  const start = Date.now();
  while (!frame().includes(until) && Date.now() - start < 3000) await sleep(20);
  return frame;
}

describe('@ file suggestions', () => {
  it('finds the token at the cursor', () => {
    expect(completionToken({ value: 'look at @', cursor: 9 })).toMatchObject({
      kind: 'file',
      query: '',
      start: 8,
    });
    expect(completionToken({ value: 'x @src/ap', cursor: 9 })).toMatchObject({
      query: 'src/ap',
    });
  });

  it('shows the top level as soon as @ is typed, with folder and file markers', async () => {
    const root = await tree({ 'src/app.ts': 'x', 'README.md': 'x' });
    const frame = await show('@', new FileIndex(root), '|file');
    expect(frame()).toContain('▸ @src/');
    expect(frame()).toContain('· @README.md');
    // a folder completes without a trailing space so its children show next
    expect(frame()).toContain('@src/|folder');
    expect(frame()).toContain('@README.md |file');
  });

  it('lists a folder’s children after @dir/', async () => {
    const root = await tree({ 'src/app.ts': 'x', 'src/api/client.ts': 'x' });
    const frame = await show('@src/', new FileIndex(root), '@src/app.ts');
    expect(frame()).toContain('@src/api/');
    expect(frame()).toContain('@src/app.ts');
  });

  it('says when there are more matches than shown', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 15; i++) files[`note${String(i)}.md`] = 'x';
    const frame = await show('@note', new FileIndex(await tree(files)), 'keep typing');
    expect(frame()).toContain('… more — keep typing to narrow');
  });
});
