import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applySummary,
  CheckpointError,
  CheckpointStore,
  describeSessionIssues,
  HookRunner,
  detectShell,
  parseSession,
  safeTailStart,
  SessionStore,
  userRequests,
  type ChatMessage,
} from '../src/index.js';

let root: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vinax-recovery-')));
});
afterEach(async () => {
  await fs.chmod(path.join(root, 'locked.txt'), 0o644).catch(() => undefined);
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const write = async (file: string, text: string) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
};
const read = (file: string) => fs.readFile(file, 'utf8');

/** Simulates one VinaX tool call: snapshot, write, record the result. */
async function vinaxWrite(cp: CheckpointStore, file: string, text: string) {
  await cp.capture([file]);
  await write(file, text);
  await cp.recordResult([file]);
}

describe('CheckpointStore: snapshots', () => {
  it('refuses to snapshot a file it cannot read instead of recording it as missing', async () => {
    const file = path.join(root, 'locked.txt');
    await write(file, 'secret');
    await fs.chmod(file, 0o000);
    const cp = new CheckpointStore();
    cp.beginTurn(1);
    // (root can read anything; the check only means something for normal users)
    if (process.getuid?.() === 0) return;
    await expect(cp.capture([file])).rejects.toBeInstanceOf(CheckpointError);
    await expect(cp.capture([file])).rejects.toThrow(/EACCES.*not made/);
    // nothing was recorded, so a rewind cannot delete the file
    expect(cp.changedSince(1)).toEqual([]);
  });

  it('refuses to snapshot a directory or a non-UTF-8 file', async () => {
    const dir = path.join(root, 'dir');
    await fs.mkdir(dir);
    const bin = path.join(root, 'image.bin');
    await fs.writeFile(bin, Buffer.from([0xff, 0xfe, 0x00, 0x80]));
    const cp = new CheckpointStore();
    cp.beginTurn(1);
    await expect(cp.capture([dir])).rejects.toThrow(/EISDIR/);
    await expect(cp.capture([bin])).rejects.toThrow(/not UTF-8/);
  });

  it('records a missing file as missing (ENOENT) and deletes it on rewind', async () => {
    const file = path.join(root, 'new.txt');
    const cp = new CheckpointStore();
    cp.beginTurn(1);
    await vinaxWrite(cp, file, 'created');
    const r = await cp.restoreTo(1);
    expect(r).toMatchObject({ status: 'restored', restored: [file] });
    await expect(fs.stat(file)).rejects.toThrow(/ENOENT/);
  });
});

describe('CheckpointStore: rewind after outside edits', () => {
  it('refuses to overwrite a file edited after VinaX changed it, and previews the conflict', async () => {
    const a = path.join(root, 'a.txt');
    const b = path.join(root, 'b.txt');
    await write(a, 'a1');
    await write(b, 'b1');
    const cp = new CheckpointStore(undefined, path.join(root, 'backups'));
    cp.beginTurn(1);
    await vinaxWrite(cp, a, 'a2');
    await vinaxWrite(cp, b, 'b2');
    await write(a, 'a2 + my edit'); // the user edits a.txt in their editor

    const plan = await cp.planRestore(1);
    expect(plan.conflicts).toEqual([
      expect.objectContaining({ file: a, status: 'modified', action: 'write', target: 'a1' }),
    ]);
    expect(plan.files.find((f) => f.file === b)).toMatchObject({ status: 'clean' });

    const refused = await cp.restoreTo(1);
    expect(refused.status).toBe('conflicts');
    expect(await read(a)).toBe('a2 + my edit');
    expect(await read(b)).toBe('b2');
    // nothing was forgotten: the user can still decide
    expect(cp.changedSince(1)).toEqual([a, b]);
  });

  it('can keep the edited files and restore only the others', async () => {
    const a = path.join(root, 'a.txt');
    const b = path.join(root, 'b.txt');
    await write(a, 'a1');
    await write(b, 'b1');
    const cp = new CheckpointStore();
    cp.beginTurn(1);
    await vinaxWrite(cp, a, 'a2');
    await vinaxWrite(cp, b, 'b2');
    await write(a, 'mine');
    const r = await cp.restoreTo(1, { resolution: 'keep' });
    expect(r).toMatchObject({ status: 'restored', restored: [b], kept: [a] });
    expect(await read(a)).toBe('mine');
    expect(await read(b)).toBe('b1');
  });

  it('overwrites on request after saving the current versions to a backup folder', async () => {
    const a = path.join(root, 'a.txt');
    await write(a, 'a1');
    const backups = path.join(root, 'backups');
    const cp = new CheckpointStore(undefined, backups);
    cp.beginTurn(1);
    await vinaxWrite(cp, a, 'a2');
    await write(a, 'mine');
    const r = await cp.restoreTo(1, { resolution: 'overwrite' });
    expect(r.status).toBe('restored');
    expect(await read(a)).toBe('a1');
    const manifest = JSON.parse(await read(path.join(r.backup ?? '', 'manifest.json'))) as {
      files: { file: string; copy: string }[];
    };
    expect(manifest.files[0]?.file).toBe(a);
    expect(await read(path.join(r.backup ?? '', manifest.files[0]?.copy ?? ''))).toBe('mine');
  });

  it('notices a file deleted outside VinaX', async () => {
    const a = path.join(root, 'a.txt');
    await write(a, 'a1');
    const cp = new CheckpointStore();
    cp.beginTurn(1);
    await vinaxWrite(cp, a, 'a2');
    await fs.rm(a);
    const plan = await cp.planRestore(1);
    expect(plan.conflicts[0]).toMatchObject({ status: 'modified', current: null });
  });

  it('notices an edit made between two VinaX turns', async () => {
    const a = path.join(root, 'a.txt');
    await write(a, 'v1');
    const cp = new CheckpointStore();
    cp.beginTurn(1);
    await vinaxWrite(cp, a, 'v2');
    await write(a, 'v2 + mine'); // between turns
    cp.beginTurn(2);
    await vinaxWrite(cp, a, 'v3');
    const plan = await cp.planRestore(1);
    expect(plan.conflicts[0]).toMatchObject({
      status: 'modified',
      reason: expect.stringMatching(/between/) as unknown,
    });
    // rewinding only turn 2 loses nothing of the user's
    expect((await cp.planRestore(2)).conflicts).toEqual([]);
  });

  it('treats a file without a recorded result (older sessions) as unverified', async () => {
    const a = path.join(root, 'a.txt');
    await write(a, 'v1');
    const cp = new CheckpointStore();
    cp.beginTurn(1);
    await cp.capture([a]);
    await write(a, 'v2');
    expect((await cp.planRestore(1)).conflicts[0]).toMatchObject({ status: 'unverified' });
  });

  it('puts already-restored files back when a later write fails partway', async () => {
    const a = path.join(root, 'a.txt');
    const sub = path.join(root, 'sub');
    const b = path.join(sub, 'b.txt');
    await write(a, 'a1');
    await write(b, 'b1');
    const cp = new CheckpointStore(undefined, path.join(root, 'backups'));
    cp.beginTurn(1);
    await vinaxWrite(cp, a, 'a2');
    await vinaxWrite(cp, b, 'b2');
    // make b.txt impossible to write: a.txt (first in order) is restored, then b.txt fails
    await fs.chmod(sub, 0o500);
    await fs.chmod(b, 0o400);
    try {
      if (process.getuid?.() === 0) return;
      const r = await cp.restoreTo(1);
      expect(r.status).toBe('failed');
      expect(r.rolledBack).toBe(true);
      expect(r.error).toMatch(/b\.txt.*put back/);
      expect(await read(a)).toBe('a2');
      expect(await read(b)).toBe('b2');
      // the snapshots stay, so the user can fix the problem and try again
      expect(cp.changedSince(1)).toEqual([a, b]);
    } finally {
      await fs.chmod(sub, 0o700);
      await fs.chmod(b, 0o600);
    }
  });

  it('undoes one file on its own and stops tracking only that file', async () => {
    const a = path.join(root, 'a.txt');
    const b = path.join(root, 'b.txt');
    await write(a, 'a1');
    await write(b, 'b1');
    const cp = new CheckpointStore();
    cp.beginTurn(1);
    await vinaxWrite(cp, a, 'a2');
    cp.beginTurn(2);
    await vinaxWrite(cp, a, 'a3');
    await vinaxWrite(cp, b, 'b2');
    expect(cp.sessionChanges()).toEqual([
      expect.objectContaining({
        file: a,
        firstTurn: 1,
        turns: [1, 2],
        original: 'a1',
        latest: 'a3',
      }),
      expect.objectContaining({ file: b, firstTurn: 2, original: 'b1', latest: 'b2' }),
    ]);
    const r = await cp.restoreTo(1, { only: [a] });
    expect(r).toMatchObject({ status: 'restored', restored: [a] });
    expect(await read(a)).toBe('a1');
    expect(await read(b)).toBe('b2');
    expect(cp.sessionChanges().map((c) => c.file)).toEqual([b]);
  });

  it('persists results and forgets through the session file', async () => {
    const store = new SessionStore(path.join(root, 'data'), root);
    const w = store.create();
    const a = path.join(root, 'a.txt');
    const b = path.join(root, 'b.txt');
    await write(a, 'a1');
    await write(b, 'b1');
    const cp = new CheckpointStore(w);
    cp.beginTurn(1);
    await vinaxWrite(cp, a, 'a2');
    await vinaxWrite(cp, b, 'b2');
    await cp.restoreTo(1, { only: [b] });

    const loaded = store.load(w.id);
    const again = new CheckpointStore();
    again.load(loaded.checkpoints, loaded.checkpointResults);
    expect(again.changedSince(1)).toEqual([a]);
    expect((await again.planRestore(1)).conflicts).toEqual([]);
    await write(a, 'mine');
    expect((await again.planRestore(1)).conflicts).toHaveLength(1);
  });
});

describe('SessionStore: validation and recovery', () => {
  const dataDir = () => path.join(root, 'data');

  it('separates a torn last line from damage in the middle', () => {
    const good = JSON.stringify({ type: 'title', title: 'x' });
    expect(parseSession(`${good}\n{"type":"mess`).issues).toEqual([
      { line: 2, kind: 'torn', message: expect.any(String) as unknown },
    ]);
    const mid = parseSession(`${good}\nnot json\n${good}\n`);
    expect(mid.issues).toEqual([{ line: 2, kind: 'malformed', message: 'not valid JSON' }]);
    expect(mid.entries).toHaveLength(2);
  });

  it('rejects entries of a known type with the wrong shape, and skips unknown types quietly', () => {
    const text = [
      JSON.stringify({ type: 'message', message: { role: 'user', content: 42 } }),
      JSON.stringify({ type: 'message', message: { role: 'wizard', content: 'x' } }),
      JSON.stringify({ type: 'turn', turn: -1, messageIndex: 0, prompt: 'p' }),
      JSON.stringify({ type: 'some_future_entry', data: 1 }),
      JSON.stringify([1, 2]),
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'ok', extra: true } }),
      '',
    ].join('\n');
    const { entries, issues } = parseSession(text);
    expect(issues.map((i) => [i.line, i.kind])).toEqual([
      [1, 'invalid'],
      [2, 'invalid'],
      [3, 'invalid'],
      [5, 'invalid'],
    ]);
    expect(issues[0]?.message).toMatch(/message\.content/);
    expect(entries).toEqual([
      { type: 'message', message: { role: 'user', content: 'ok', extra: true } },
    ]);
  });

  it('keeps entries recorded after resuming a session whose last write was torn', () => {
    const store = new SessionStore(dataDir(), root);
    const w = store.create();
    w.record({ type: 'turn', turn: 1, messageIndex: 0, prompt: 'first' });
    w.record({ type: 'message', message: { role: 'user', content: 'first' } });
    fsSync.appendFileSync(w.file, '{"type":"message","message":{"role":"assis');

    const loaded = store.load(w.id);
    expect(loaded.messages).toHaveLength(1);
    expect(describeSessionIssues(loaded)).toMatchObject({ level: 'info' });

    const again = store.open(w.id);
    again.record({ type: 'message', message: { role: 'assistant', content: 'after resume' } });
    const reloaded = store.load(w.id);
    // before the fix the new entry was glued onto the fragment and lost
    expect(reloaded.messages.map((m) => m.content)).toEqual(['first', 'after resume']);
    expect(reloaded.issues).toEqual([]);
    expect(fsSync.readFileSync(`${w.file}.torn`, 'utf8')).toContain('"role":"assis');
  });

  it('adds the missing newline to a complete last entry instead of setting it aside', () => {
    const store = new SessionStore(dataDir(), root);
    const w = store.create();
    fsSync.appendFileSync(w.file, JSON.stringify({ type: 'title', title: 'kept' }));
    store.open(w.id).record({ type: 'model', model: 'groq:x' });
    const loaded = store.load(w.id);
    expect(loaded).toMatchObject({ title: 'kept', model: 'groq:x', issues: [] });
    expect(fsSync.existsSync(`${w.file}.torn`)).toBe(false);
  });

  it('reports damaged lines with their numbers and the file path', () => {
    const store = new SessionStore(dataDir(), root);
    const w = store.create();
    w.record({ type: 'turn', turn: 1, messageIndex: 0, prompt: 'first' });
    fsSync.appendFileSync(w.file, 'garbage\n');
    w.record({ type: 'message', message: { role: 'user', content: 'first' } });
    const loaded = store.load(w.id);
    expect(loaded.messages).toHaveLength(1);
    const d = describeSessionIssues(loaded);
    expect(d?.level).toBe('warning');
    expect(d?.text).toContain('line 3 (not valid JSON)');
    expect(d?.text).toContain(w.file);
    expect(store.list()[0]?.damagedLines).toBe(1);
  });

  it('explains a session whose header is unreadable', () => {
    const store = new SessionStore(dataDir(), root);
    const w = store.create();
    fsSync.writeFileSync(w.file, 'oops\n');
    expect(() => store.load(w.id)).toThrow(/no readable header \(line 1: not valid JSON\)/);
  });

  it('caches summaries and re-reads only sessions that changed', () => {
    const store = new SessionStore(dataDir(), root);
    const a = store.create(new Date('2026-01-01T00:00:00Z'));
    a.record({ type: 'turn', turn: 1, messageIndex: 0, prompt: 'alpha' });
    const b = store.create(new Date('2026-01-02T00:00:00Z'));
    b.record({ type: 'turn', turn: 1, messageIndex: 0, prompt: 'beta' });
    expect(
      store
        .list()
        .map((s) => s.firstPrompt)
        .sort(),
    ).toEqual(['alpha', 'beta']);
    const index = path.join(dataDir(), 'sessions', '.index.json');
    expect(fsSync.existsSync(index)).toBe(true);

    // a stale cache entry is never trusted: the size changed, so the file is read again
    b.record({ type: 'title', title: 'Beta work' });
    expect(store.list().find((s) => s.id === b.id)?.title).toBe('Beta work');

    // a corrupt index is ignored and rebuilt
    fsSync.writeFileSync(index, '{nope');
    expect(store.list()).toHaveLength(2);
    // deleted sessions disappear
    fsSync.rmSync(a.file);
    expect(store.list().map((s) => s.id)).toEqual([b.id]);
  });
});

describe('compaction', () => {
  const img = { mediaType: 'image/png' as const, data: 'AAAA', name: 'shot.png' };

  it('keeps the images (and other fields) of the first kept message', () => {
    const out = applySummary('S', [
      { role: 'user', content: 'what is in this picture?', images: [img] },
      { role: 'assistant', content: 'a cat' },
    ]);
    expect(out[0]).toMatchObject({ role: 'user', images: [img] });
    expect(out[0]?.content).toMatch(/^<conversation-summary>[\s\S]*what is in this picture\?$/);
  });

  it('pins the user requests and open tasks verbatim, and carries them through a second compaction', () => {
    const first = applySummary('S1', [], {
      requests: ['Fix the login bug. Do not touch the public API.'],
      tasks: '- [pending] Run the tests',
    });
    expect(first[0]?.content).toContain('Do not touch the public API.');
    expect(first[0]?.content).toContain('## Unfinished tasks\n- [pending] Run the tests');
    const history: ChatMessage[] = [
      ...first,
      { role: 'user', content: 'Also update the docs\n\n<file path="a.ts">\nx\n</file>' },
    ];
    expect(userRequests(history)).toEqual([
      'Fix the login bug. Do not touch the public API.',
      'Also update the docs',
    ]);
  });

  it('never starts the kept tail in the middle of a tool exchange', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'Read', arguments: '{}' }] },
      { role: 'tool', toolCallId: '1', name: 'Read', content: 'x' },
      { role: 'tool', toolCallId: '1', name: 'Read', content: 'y' },
      { role: 'assistant', content: 'done' },
    ];
    expect(safeTailStart(messages, 3)).toBe(1);
    expect(safeTailStart(messages, 2)).toBe(1);
    expect(safeTailStart(messages, 4)).toBe(4);
    expect(safeTailStart(messages, 5)).toBe(5);
  });
});

describe('hook cancellation', () => {
  it('stops a running hook (and what it started) at once and skips the remaining hooks', async () => {
    if (process.platform === 'win32') return;
    const marker = path.join(root, 'second-ran');
    const runner = new HookRunner(
      {
        Stop: [
          {
            hooks: [
              { type: 'command', command: 'sleep 20; echo late' },
              { type: 'command', command: `touch "${marker}"` },
            ],
          },
        ],
      },
      { cwd: root, env: process.env, shell: detectShell(), disabled: false, base: () => ({}) },
    );
    const ac = new AbortController();
    setTimeout(() => {
      ac.abort();
    }, 150);
    const started = Date.now();
    const r = await runner.run('Stop', {}, { signal: ac.signal });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(r).toMatchObject({ cancelled: true, blocked: false, warnings: [] });
    expect(fsSync.existsSync(marker)).toBe(false);
  }, 10_000);
});

describe('loop guard', () => {
  it('treats reordered JSON arguments as the same call and ignores polling tools', async () => {
    const { LoopGuard } = await import('../src/index.js');
    const g = new LoopGuard();
    expect(g.record('Read', '{"a":1,"b":2}', false, 'nope', 'x')).toEqual({});
    expect(g.record('Read', '{"b":2, "a":1}', false, 'nope', 'x').nudge).toMatch(/failed 2 times/);
    expect(g.record('Read', '{"a":1,"b":2}', false, 'nope', 'x').stop).toMatch(/failed 3 times/);
    const poll = new LoopGuard();
    for (let i = 0; i < 10; i++)
      expect(poll.record('BashOutput', '{"id":"j"}', true, 'same', 'j')).toEqual({});
  });

  it('does not count a repeated call whose result changes as a loop', async () => {
    const { LoopGuard } = await import('../src/index.js');
    const g = new LoopGuard();
    for (let i = 0; i < 8; i++)
      expect(g.record('Bash', '{"command":"date"}', true, `t${String(i)}`, 'date')).toEqual({});
  });

  it('stops after five replies in a row whose calls all failed', async () => {
    const { LoopGuard } = await import('../src/index.js');
    const g = new LoopGuard();
    for (let i = 0; i < 4; i++) {
      g.record('Bash', `{"command":"try ${String(i)}"}`, false, 'err', '');
      expect(g.endStep()).toBeUndefined();
    }
    g.record('Bash', '{"command":"try 4"}', false, 'err', '');
    expect(g.endStep()).toMatch(/last 5 replies only made tool calls that failed/);
  });
});
