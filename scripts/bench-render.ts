/**
 * Measures the chat screen with a long resumed transcript: time to the first full frame, how
 * long a typed character takes to show, and how long Ctrl+O (transcript/turn details) takes to
 * open. Pass a checkout to compare versions on the same fixture:
 *
 *   pnpm bench:render [repo-root=.] [items=2000]
 *
 * (runs through tsx with the CLI package's tsconfig, for its JSX settings)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const repo = path.resolve(process.argv[2] ?? '.');
const count = Number(process.argv[3] ?? 2000);
const runs = 5;

const src = (rel: string) => path.join(repo, 'packages', rel);
// React and the test renderer must be the CLI package's own copies (one React instance)
const cliRequire = createRequire(src('cli/package.json'));
const load = (name: string) => import(pathToFileURL(cliRequire.resolve(name)).href);
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
const { createElement } = await load('react');
const { render } = await load('ink-testing-library');
const core = await import(src('core/src/index.ts'));
const { openSession } = await import(src('cli/src/session.ts'));
const { loadCommands } = await import(src('cli/src/ui/commands/registry.ts'));
const { ChatScreen } = await import(src('cli/src/ui/components/ChatScreen.tsx'));
const { resolveTheme, ThemeContext } = await import(src('cli/src/ui/theme.ts'));

function items(n: number): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; out.length < n; i++) {
    out.push({
      kind: 'user',
      text: `Prompt ${String(i)}: fix the failing test in src/module${String(i)}.ts`,
    });
    out.push({
      kind: 'assistant',
      first: true,
      markdown: `Looking at **module ${String(i)}**.\n\n\`\`\`ts\nexport function f${String(i)}(x: number) {\n  return x * ${String(i)};\n}\n\`\`\`\n\n- one\n- two`,
    });
    out.push({
      kind: 'tool',
      name: 'Edit',
      label: `src/module${String(i)}.ts`,
      ok: true,
      summary: 'Changed +1 −1 lines',
      display: {
        kind: 'diff',
        path: `src/module${String(i)}.ts`,
        created: false,
        added: 1,
        removed: 1,
        hunks: [
          {
            lines: [
              { kind: 'context', text: 'export function f() {', oldLine: 1, newLine: 1 },
              { kind: 'remove', text: '  return 1;', oldLine: 2 },
              { kind: 'add', text: '  return 2;', newLine: 2 },
            ],
          },
        ],
      },
    });
    out.push({ kind: 'notice', level: 'info', text: `Note ${String(i)}` });
  }
  return out.slice(0, n);
}

let frameDebug: () => string = () => '';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, what: string): Promise<number> {
  const start = performance.now();
  while (!check()) {
    if (performance.now() - start > 8000) {
      console.error(frameDebug().slice(-1500));
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(1);
  }
  return performance.now() - start;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const mount: number[] = [];
const key: number[] = [];
const details: number[] = [];
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinax-bench-render-'));
const env = {
  VINAX_HOME: path.join(root, 'home'),
  VINAX_SECRETS_BACKEND: 'file',
  NO_COLOR: '1',
  PATH: process.env.PATH ?? '',
};
fs.mkdirSync(path.join(root, 'project'), { recursive: true });
const restored = items(count);
for (let r = 0; r < runs; r++) {
  const runtime = await core.createRuntime({ cwd: path.join(root, 'project'), env });
  const opened = await openSession(runtime, { kind: 'new' }, {});
  const { commands } = await loadCommands(runtime);
  const start = performance.now();
  const app = render(
    createElement(
      ThemeContext.Provider,
      { value: resolveTheme('dark', env) },
      createElement(ChatScreen, {
        runtime,
        setup: opened.setup,
        session: opened.writer,
        commands,
        version: 'bench',
        tips: [],
        restored,
        title: 'bench',
        editorMode: 'normal',
        onExit: () => undefined,
        onClear: () => undefined,
        onResume: () => undefined,
        onTheme: () => undefined,
      }),
    ),
  );
  const frame = (): string => (app.lastFrame() as string | undefined) ?? '';
  frameDebug = frame;
  await until(() => frame().includes('Try "') || frame().includes('manual mode'), 'first frame');
  mount.push(performance.now() - start);
  await sleep(50);
  app.stdin.write('Ω');
  key.push(await until(() => frame().includes('Ω'), 'keystroke'));
  app.stdin.write('\x15'); // Ctrl+U clears it
  await sleep(50);
  app.stdin.write('\x0f'); // Ctrl+O
  details.push(await until(() => frame().includes('Turn details'), 'Ctrl+O'));
  app.unmount();
  await opened.setup.close();
}
fs.rmSync(root, { recursive: true, force: true });
console.log(
  `node ${process.version} · ${os.cpus()[0]?.model ?? os.arch()} · ${repo} · ${String(count)} transcript items · ${String(runs)} runs (medians)`,
);
console.log(`first frame with resumed transcript  ${median(mount).toFixed(0).padStart(6)} ms`);
console.log(`typed character shown                ${median(key).toFixed(1).padStart(6)} ms`);
console.log(`Ctrl+O view open                     ${median(details).toFixed(1).padStart(6)} ms`);
process.exit(0);
