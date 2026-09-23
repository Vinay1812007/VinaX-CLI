import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { startMockServer, type MockServer } from '@vinax/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  compareVersions,
  detectInstall,
  latestRelease,
  runUpdate,
  updateBinary,
} from '../src/update.js';
import { createHarness, type Harness } from './helpers.js';

let h: Harness | undefined;
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
  await Promise.all(closers.splice(0).map((c) => c()));
});

const posix = process.platform !== 'win32';

/** Serves a fake GitHub "latest release" with a binary and its SHA256SUMS. */
async function releaseServer(opts: { version: string; binary: Buffer; corrupt?: boolean }) {
  const sum = createHash('sha256').update(opts.binary).digest('hex');
  const server = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    if (req.url === '/latest') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          tag_name: `v${opts.version}`,
          assets: [
            { name: 'vinax-linux-x64', browser_download_url: `${base}/vinax-linux-x64` },
            { name: 'SHA256SUMS', browser_download_url: `${base}/SHA256SUMS` },
          ],
        }),
      );
    } else if (req.url === '/SHA256SUMS') {
      res.end(`${opts.corrupt === true ? '0'.repeat(64) : sum}  vinax-linux-x64\n`);
    } else if (req.url === '/vinax-linux-x64') {
      res.end(opts.binary);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.push(
    () =>
      new Promise((r) => {
        server.close(() => {
          r();
        });
      }),
  );
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/latest`;
}

describe('vinax update', () => {
  it('compares versions, including pre-releases', () => {
    expect(compareVersions('0.2.0', '0.1.9')).toBe(1);
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(-1);
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1);
  });

  it('knows how it was installed', () => {
    expect(detectInstall('linux-x64', '/usr/local/bin/vinax', '/$bunfs/root/vinax')).toEqual({
      kind: 'binary',
      path: '/usr/local/bin/vinax',
      target: 'linux-x64',
    });
    expect(
      detectInstall(undefined, '/usr/bin/node', '/usr/lib/node_modules/vinax/dist/vinax.js'),
    ).toEqual({ kind: 'npm' });
    expect(
      detectInstall(undefined, '/usr/bin/node', '/home/me/VinaX-CLI/packages/cli/dist/vinax.js'),
    ).toEqual({
      kind: 'source',
    });
  });

  it.skipIf(!posix)('replaces the binary after checking its checksum', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vinax-update-'));
    closers.push(() =>
      fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }),
    );
    const exe = path.join(dir, 'vinax');
    await fs.writeFile(exe, '#!/bin/sh\necho 0.1.0\n', { mode: 0o755 });
    const url = await releaseServer({
      version: '0.2.0',
      binary: Buffer.from('#!/bin/sh\necho 0.2.0\n'),
    });
    const lines: string[] = [];
    const io = { out: (s: string) => lines.push(s), err: (s: string) => lines.push(`ERR ${s}`) };
    const install = { kind: 'binary' as const, path: exe, target: 'linux-x64' };

    expect(
      await runUpdate('0.1.0', { check: true, env: { VINAX_UPDATE_URL: url }, install }, io),
    ).toBe(0);
    expect(lines.pop()).toBe('VinaX v0.2.0 is available (you have v0.1.0). Run: vinax update');
    expect(await fs.readFile(exe, 'utf8')).toContain('0.1.0');

    expect(
      await runUpdate('0.1.0', { check: false, env: { VINAX_UPDATE_URL: url }, install }, io),
    ).toBe(0);
    expect(lines.at(-1)).toBe(`✔ Updated ${exe} to v0.2.0.`);
    expect(await fs.readFile(exe, 'utf8')).toContain('0.2.0');
    expect((await fs.stat(exe)).mode & 0o111).not.toBe(0);

    expect(
      await runUpdate('0.2.0', { check: false, env: { VINAX_UPDATE_URL: url }, install }, io),
    ).toBe(0);
    expect(lines.at(-1)).toBe('✔ VinaX v0.2.0 is up to date.');
  });

  it('refuses a download whose checksum does not match', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vinax-update-'));
    closers.push(() =>
      fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }),
    );
    const exe = path.join(dir, 'vinax');
    await fs.writeFile(exe, 'old');
    const url = await releaseServer({
      version: '0.2.0',
      binary: Buffer.from('new'),
      corrupt: true,
    });
    const release = await latestRelease({ VINAX_UPDATE_URL: url });
    await expect(updateBinary({ path: exe, target: 'linux-x64' }, release)).rejects.toThrow(
      /checksum mismatch/,
    );
    expect(await fs.readFile(exe, 'utf8')).toBe('old');
    await expect(updateBinary({ path: exe, target: 'darwin-arm64' }, release)).rejects.toThrow(
      /has no vinax-darwin-arm64/,
    );
  });

  it('tells source checkouts to use git', async () => {
    const lines: string[] = [];
    const code = await runUpdate(
      '0.1.0',
      { check: false, env: {}, install: { kind: 'source' } },
      { out: (s) => lines.push(s), err: (s) => lines.push(s) },
    );
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('git pull');
  });
});

describe('vinax login --gateway', () => {
  it('checks the token, saves the gateway and routes providers through it', async () => {
    let gw: MockServer | undefined;
    try {
      gw = await startMockServer({
        apiKeys: ['vxg_good'],
        health: () => true,
        models: [{ id: 'groq:main-model' }],
        script: { 'groq:main-model': [{ text: 'answer from the gateway' }] },
      });
      h = await createHarness({ keys: false });
      const url = gw.url.replace(/\/v1$/, '');

      const bad = await h.run(['login', '--gateway', url], { stdin: 'vxg_bad\n' });
      expect(bad.code).toBe(1);
      expect(bad.stderr).toContain('the gateway rejected that token; nothing was saved');

      const insecure = await h.run(['login', '--gateway', 'http://gw.example.com'], {
        stdin: 'vxg_good\n',
      });
      expect(insecure.code).toBe(2);
      expect(insecure.stderr).toContain('https://');

      const ok = await h.run(['login', '--gateway', `${url}/`], { stdin: 'vxg_good\n' });
      expect(ok.code).toBe(0);
      expect(ok.stdout).toContain('Connected to the VinaX gateway vmock (1 models)');
      expect(ok.stdout).toContain('Every request now goes through the gateway.');
      const settings = JSON.parse(
        await fs.readFile(path.join(h.home, 'settings.json'), 'utf8'),
      ) as {
        gateway: { url: string };
      };
      expect(settings.gateway.url).toBe(url);

      const answer = await h.run(['-p', 'hi']);
      expect(answer.stdout).toContain('answer from the gateway');

      const doctor = await h.run(['doctor']);
      expect(doctor.stdout).toMatch(/Gateway\s+.* is up/);

      const out = await h.run(['logout', '--gateway']);
      expect(out.stdout).toContain('Disconnected from the VinaX gateway.');
      expect((await h.run(['login'])).code).toBe(2);
    } finally {
      await gw?.close();
    }
  });
});
