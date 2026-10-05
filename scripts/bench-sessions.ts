/**
 * Measures how long listing and loading saved sessions takes on a synthetic project, so changes
 * to the session store can be compared on the same fixture. Run with:
 *
 *   pnpm bench:sessions [sessions=300] [turns=25]
 *
 * Each turn writes what a typical coding turn does: the prompt, an assistant message with a tool
 * call, a 2 KB tool result, a 1 KB answer and four transcript view entries.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { SessionStore } from '../packages/core/src/session/store.js';

const sessions = Number(process.argv[2] ?? 300);
const turns = Number(process.argv[3] ?? 25);
const runs = 5;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinax-bench-'));
const store = new SessionStore(root, '/project');
const filler = (n: number): string =>
  'lorem ipsum dolor sit amet '.repeat(Math.ceil(n / 27)).slice(0, n);

const t0 = performance.now();
for (let s = 0; s < sessions; s++) {
  const w = store.create(new Date(Date.UTC(2026, 0, 1, 0, 0, s)));
  for (let t = 1; t <= turns; t++) {
    const prompt = `turn ${String(t)}: ${filler(200)}`;
    w.record({ type: 'turn', turn: t, messageIndex: t * 4, prompt });
    w.record({ type: 'message', message: { role: 'user', content: prompt } });
    w.record({
      type: 'message',
      message: {
        role: 'assistant',
        content: 'Reading.',
        toolCalls: [{ id: `c${String(t)}`, name: 'Read', arguments: '{"file_path":"src/a.ts"}' }],
      },
    });
    w.record({
      type: 'message',
      message: { role: 'tool', toolCallId: `c${String(t)}`, name: 'Read', content: filler(2048) },
    });
    w.record({ type: 'message', message: { role: 'assistant', content: filler(1024) } });
    for (let v = 0; v < 4; v++)
      w.record({ type: 'view', data: { kind: 'notice', text: filler(300) } });
  }
  if (s % 3 === 0) w.record({ type: 'title', title: `Session ${String(s)}` });
}
const writeMs = performance.now() - t0;
const bytes = fs
  .readdirSync(path.join(root, 'sessions'))
  .reduce((n, f) => n + fs.statSync(path.join(root, 'sessions', f)).size, 0);

function time(label: string, fn: () => unknown): void {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)] ?? 0;
  console.log(
    `${label.padEnd(28)} median ${median.toFixed(1).padStart(8)} ms   (min ${(samples[0] ?? 0).toFixed(1)}, max ${(samples.at(-1) ?? 0).toFixed(1)})`,
  );
}

console.log(
  `node ${process.version} · ${os.cpus()[0]?.model ?? os.arch()} · ${sessions} sessions × ${turns} turns · ${(bytes / 1024 / 1024).toFixed(1)} MB (written in ${writeMs.toFixed(0)} ms)`,
);
const index = path.join(root, 'sessions', '.index.json');
time('list() no index (cold)', () => {
  fs.rmSync(index, { force: true });
  return new SessionStore(root, '/project').list();
});
time('list() index up to date', () => new SessionStore(root, '/project').list());
const active = new SessionStore(root, '/project').list()[0];
let n = 0;
time('list() one session changed', () => {
  // the common case: only the session in use grew since the last listing
  fs.appendFileSync(
    active?.file ?? '',
    `${JSON.stringify({ type: 'title', title: `t${String(n++)}` })}\n`,
  );
  return new SessionStore(root, '/project').list();
});
const id = active?.id ?? '';
time('load() one session', () => store.load(id));
fs.rmSync(root, { recursive: true, force: true });
