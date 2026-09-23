/**
 * Builds standalone `vinax` executables with Bun. Run with Bun (not Node):
 *
 *   bun scripts/build-binaries.ts                     # every target
 *   bun scripts/build-binaries.ts darwin-arm64 ...    # only these
 *
 * Output goes to dist-bin/vinax-<os>-<arch>[.exe]. Two optional native pieces cannot be embedded
 * for other platforms, so they are left out: the OS keychain (keys go to ~/.vinax/credentials.json,
 * mode 0600) and the bundled ripgrep (Grep uses `rg` from PATH, or its JavaScript search).
 */
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

export const TARGETS = {
  'linux-x64': 'bun-linux-x64-baseline',
  'linux-arm64': 'bun-linux-arm64',
  'linux-x64-musl': 'bun-linux-x64-musl-baseline',
  'linux-arm64-musl': 'bun-linux-arm64-musl',
  'darwin-x64': 'bun-darwin-x64',
  'darwin-arm64': 'bun-darwin-arm64',
  'windows-x64': 'bun-windows-x64-baseline',
  'windows-arm64': 'bun-windows-arm64',
} as const;
type TargetName = keyof typeof TARGETS;

const root = path.resolve(import.meta.dir, '..');
const outDir = path.join(root, 'dist-bin');
const bundleDir = path.join(outDir, '.bundle');

// Modules replaced with stubs that fail to load, so the dynamic imports that use them take their
// fallback path. react-devtools-core is only used by Ink when DEV=true.
const STUBS: Record<string, string> = {
  '@napi-rs/keyring':
    'throw new Error("the OS keychain is not available in the standalone binary");',
  '@vscode/ripgrep':
    'throw new Error("bundled ripgrep is not available in the standalone binary");',
  'react-devtools-core': 'export default { initialize() {}, connectToDevTools() {} };',
};

function isTarget(name: string): name is TargetName {
  return name in TARGETS;
}

/** Bundles once per target: the target name is compiled in so `vinax update` fetches the same one. */
async function bundle(name: TargetName): Promise<string> {
  const result = await Bun.build({
    entrypoints: [path.join(root, 'packages/cli/src/bin.ts')],
    outdir: path.join(bundleDir, name),
    target: 'bun',
    format: 'esm',
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"', __VINAX_TARGET__: JSON.stringify(name) },
    plugins: [
      {
        name: 'vinax-binary-stubs',
        setup(build) {
          const filter = new RegExp(
            `^(${Object.keys(STUBS)
              .map((s) => s.replace(/[/.*+?^${}()|[\]\\]/g, '\\$&'))
              .join('|')})$`,
          );
          build.onResolve({ filter }, (args) => ({ path: args.path, namespace: 'vinax-stub' }));
          build.onLoad({ filter: /.*/, namespace: 'vinax-stub' }, (args) => ({
            contents: STUBS[args.path] ?? '',
            loader: 'js',
          }));
        },
      },
    ],
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error('bundling failed');
  }
  const entry = result.outputs.find((o) => o.kind === 'entry-point');
  if (!entry) throw new Error('bundling produced no entry point');
  return entry.path;
}

async function compile(entry: string, name: TargetName): Promise<void> {
  const outfile = path.join(outDir, `vinax-${name}${name.startsWith('windows') ? '.exe' : ''}`);
  const proc = Bun.spawn(
    [
      process.execPath,
      'build',
      entry,
      '--compile',
      `--target=${TARGETS[name]}`,
      '--outfile',
      outfile,
    ],
    { stdout: 'inherit', stderr: 'inherit' },
  );
  if ((await proc.exited) !== 0) throw new Error(`compiling ${name} failed`);
}

const requested = process.argv.slice(2);
const unknown = requested.filter((t) => !isTarget(t));
if (unknown.length > 0) {
  console.error(
    `Unknown target(s): ${unknown.join(', ')}. Known: ${Object.keys(TARGETS).join(', ')}`,
  );
  process.exit(2);
}
const targets =
  requested.length > 0 ? requested.filter(isTarget) : (Object.keys(TARGETS) as TargetName[]);

await mkdir(outDir, { recursive: true });
for (const t of targets) {
  console.log(`→ vinax-${t}`);
  await compile(await bundle(t), t);
}
await rm(bundleDir, { recursive: true, force: true });
