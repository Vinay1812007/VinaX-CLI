import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileSecretBackend, maskSecret, openSecretStore, SecretStore } from '../src/index.js';

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'vinax-secrets-'));
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('secrets', () => {
  it('stores keys in a 0600 file when the file backend is forced', async () => {
    const store = await openSecretStore({ VINAX_HOME: home, VINAX_SECRETS_BACKEND: 'file' });
    expect(await store.set('groq', 'gsk_test_value')).toBe('file');
    expect(await store.get('groq')).toEqual({ value: 'gsk_test_value', source: 'file' });
    if (process.platform !== 'win32') {
      const stat = await fs.stat(path.join(home, 'credentials.json'));
      expect(stat.mode & 0o777).toBe(0o600);
    }
    expect(await store.delete('groq')).toBe(true);
    expect(await store.get('groq')).toBeUndefined();
  });

  it('lets environment variables override stored keys', async () => {
    const store = await openSecretStore({
      VINAX_HOME: home,
      VINAX_SECRETS_BACKEND: 'file',
      OPENROUTER_API_KEY: '  sk-or-from-env ',
    });
    await store.set('openrouter', 'sk-or-stored');
    expect(await store.get('openrouter')).toEqual({ value: 'sk-or-from-env', source: 'env' });
  });

  it('falls back to the next backend when the keychain fails', async () => {
    const file = new FileSecretBackend(path.join(home, 'credentials.json'));
    const broken = {
      kind: 'keychain' as const,
      get: () => Promise.reject(new Error('no secret service')),
      set: () => Promise.reject(new Error('no secret service')),
      delete: () => Promise.reject(new Error('no secret service')),
    };
    const store = new SecretStore([broken, file], {});
    expect(await store.set('groq', 'gsk_abc')).toBe('file');
    expect(await store.get('groq')).toEqual({ value: 'gsk_abc', source: 'file' });
  });

  it('masks secrets for display', () => {
    expect(maskSecret('gsk_1234567890abcd')).toBe('gsk_…abcd');
    expect(maskSecret('short')).toBe('••••');
  });
});
