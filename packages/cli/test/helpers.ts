import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import {
  startMockServer,
  systemEnv,
  type MockServer,
  type MockServerOptions,
} from '@vinax/testkit';
import type { CliIO } from '../src/io.js';
import { main } from '../src/main.js';

export interface Harness {
  home: string;
  cwd: string;
  groq: MockServer;
  openrouter: MockServer;
  env: Record<string, string>;
  run(args: string[], opts?: { stdin?: string; signal?: AbortSignal }): Promise<RunResult>;
  cleanup(): Promise<void>;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function collect(stream: PassThrough): () => string {
  let data = '';
  stream.setEncoding('utf8');
  stream.on('data', (c: string) => (data += c));
  return () => data;
}

/** Temp VINAX_HOME + project dir, with Groq and OpenRouter replaced by local mock servers. */
export async function createHarness(
  opts: {
    groq?: MockServerOptions;
    openrouter?: MockServerOptions;
    settings?: Record<string, unknown>;
    keys?: boolean;
  } = {},
): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vinax-cli-'));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'project');
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(cwd, { recursive: true });
  const groq = await startMockServer(opts.groq);
  const openrouter = await startMockServer(opts.openrouter);
  await fs.writeFile(
    path.join(home, 'settings.json'),
    JSON.stringify({
      model: 'groq:main-model',
      smallModel: 'groq:small-model',
      fallbackChain: ['openrouter:free-model:free'],
      providers: { groq: { baseUrl: groq.url }, openrouter: { baseUrl: openrouter.url } },
      router: {
        maxRetries: 1,
        baseDelayMs: 5,
        maxDelayMs: 20,
        maxWaitMs: 1000,
        requestTimeoutMs: 5000,
      },
      ...opts.settings,
    }),
  );
  const env: Record<string, string> = {
    ...systemEnv(),
    VINAX_HOME: home,
    VINAX_SECRETS_BACKEND: 'file',
    NO_COLOR: '1',
    ...(opts.keys === false
      ? {}
      : { GROQ_API_KEY: 'gsk_mockkey0000000000', OPENROUTER_API_KEY: 'sk-or-v1-mockkey000000' }),
  };

  return {
    home,
    cwd,
    groq,
    openrouter,
    env,
    async run(args, runOpts = {}) {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const readOut = collect(stdout);
      const readErr = collect(stderr);
      const stdin = Object.assign(
        Readable.from(runOpts.stdin === undefined ? [] : [runOpts.stdin]),
        {
          isTTY: false,
        },
      );
      const io: CliIO = { stdin, stdout, stderr, env, cwd };
      const code = await main(args, io, runOpts.signal);
      return { code, stdout: readOut(), stderr: readErr() };
    },
    async cleanup() {
      await groq.close();
      await openrouter.close();
      await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}
