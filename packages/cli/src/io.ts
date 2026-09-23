import type { Readable, Writable } from 'node:stream';
import { styleText } from 'node:util';
import type { Env } from '@vinax/core';

export type InStream = Readable & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
export type OutStream = Writable & { isTTY?: boolean };

export interface CliIO {
  stdin: InStream;
  stdout: OutStream;
  stderr: OutStream;
  env: Env;
  cwd: string;
}

export function processIO(): CliIO {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    cwd: process.cwd(),
  };
}

type Style = Parameters<typeof styleText>[0];

/** Styles text only for a colour-capable TTY; honours NO_COLOR / FORCE_COLOR. */
export function paint(stream: OutStream, style: Style, text: string, env: Env): string {
  const forced = env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0';
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '' && !forced) return text;
  if (stream.isTTY !== true && !forced) return text;
  return styleText(style, text, { validateStream: false });
}

export async function readAll(stream: Readable): Promise<string> {
  let data = '';
  stream.setEncoding('utf8');
  for await (const chunk of stream) data += chunk as string;
  return data;
}

/** Reads a secret without echoing it on a TTY; reads the whole stream when input is piped. */
export async function readSecret(io: CliIO, prompt: string): Promise<string> {
  const { stdin, stderr } = io;
  if (stdin.isTTY !== true || !stdin.setRawMode) return (await readAll(stdin)).trim();
  stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();
  try {
    return await new Promise<string>((resolve, reject) => {
      let value = '';
      const onData = (chunk: string): void => {
        for (const ch of chunk) {
          if (ch === '\r' || ch === '\n') {
            stdin.off('data', onData);
            stderr.write('\n');
            resolve(value.trim());
            return;
          }
          if (ch === '\u0003') {
            stdin.off('data', onData);
            stderr.write('\n');
            reject(new Error('Cancelled'));
            return;
          }
          if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
          else value += ch;
        }
      };
      stdin.on('data', onData);
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }
}
