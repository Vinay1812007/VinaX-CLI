/**
 * Measures process startup of a built CLI: `--version` (module loading), `--help`, and a full
 * `-p` answer from a local mock provider (settings, catalog, session, one model call). Run with:
 *
 *   pnpm build && pnpm bench:startup [path/to/vinax.js] [runs=15]
 *
 * No network: providers point at an in-process mock server.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { startMockServer } from '../packages/testkit/src/index.js';

const bin = path.resolve(process.argv[2] ?? 'packages/cli/dist/vinax.js');
const runs = Number(process.argv[3] ?? 15);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinax-bench-start-'));
const home = path.join(root, 'home');
const project = path.join(root, 'project');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(project, { recursive: true });

const groq = await startMockServer({
  models: [{ id: 'main-model' }, { id: 'small-model' }],
  script: { '*': Array.from({ length: runs + 5 }, () => ({ text: 'hello' })) },
});
fs.writeFileSync(
  path.join(home, 'settings.json'),
  JSON.stringify({
    model: 'groq:main-model',
    smallModel: 'groq:small-model',
    fallbackChain: [],
    updateCheck: false,
    providers: {
      groq: { baseUrl: groq.url },
      openrouter: { enabled: false },
      nvidia: { enabled: false },
    },
  }),
);
const env = {
  PATH: process.env.PATH ?? '',
  HOME: home,
  VINAX_HOME: home,
  VINAX_SECRETS_BACKEND: 'file',
  VINAX_NO_UPDATE_CHECK: '1',
  GROQ_API_KEY: 'gsk_bench000000000',
  NO_COLOR: '1',
};

function time(label: string, args: string[]): void {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    const r = spawnSync(process.execPath, [bin, ...args], {
      cwd: project,
      env,
      encoding: 'utf8',
      input: '',
    });
    samples.push(performance.now() - start);
    if (r.status !== 0) throw new Error(`${label} exited ${String(r.status)}: ${r.stderr}`);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)] ?? 0;
  console.log(
    `${label.padEnd(24)} median ${median.toFixed(0).padStart(5)} ms   (min ${(samples[0] ?? 0).toFixed(0)}, max ${(samples.at(-1) ?? 0).toFixed(0)})`,
  );
}

async function timeAsync(label: string, args: string[]): Promise<void> {
  const { spawn } = await import('node:child_process');
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [bin, ...args], { cwd: project, env, stdio: 'pipe' });
      // print mode reads piped stdin until it closes
      child.stdin.end();
      let err = '';
      child.stderr.on('data', (d: Buffer) => (err += d.toString()));
      child.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${label} exited ${String(code)}: ${err}`));
      });
    });
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)] ?? 0;
  console.log(
    `${label.padEnd(24)} median ${median.toFixed(0).padStart(5)} ms   (min ${(samples[0] ?? 0).toFixed(0)}, max ${(samples.at(-1) ?? 0).toFixed(0)})`,
  );
}

console.log(
  `node ${process.version} · ${os.cpus()[0]?.model ?? os.arch()} · ${bin} · ${String(runs)} runs`,
);
time('vinax --version', ['--version']);
time('vinax --help', ['--help']);
await timeAsync('vinax -p (mock provider)', ['-p', 'hi']);
await groq.close();
fs.rmSync(root, { recursive: true, force: true });
