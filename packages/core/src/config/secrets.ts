import fs from 'node:fs/promises';
import path from 'node:path';
import { vinaxHome, type Env } from './paths.js';
import type { ProviderName } from './schema.js';

export type SecretName = ProviderName;
export type SecretSource = 'env' | 'keychain' | 'file';

export const SECRET_ENV_VARS: Record<SecretName, string> = {
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

interface SecretBackend {
  readonly kind: Exclude<SecretSource, 'env'>;
  get(name: SecretName): Promise<string | undefined>;
  set(name: SecretName, value: string): Promise<void>;
  delete(name: SecretName): Promise<boolean>;
}

const KEYCHAIN_SERVICE = 'vinax';

interface KeyringEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
}
type KeyringEntryCtor = new (service: string, account: string) => KeyringEntry;

class KeychainBackend implements SecretBackend {
  readonly kind = 'keychain';
  constructor(private readonly Entry: KeyringEntryCtor) {}

  get(name: SecretName): Promise<string | undefined> {
    return Promise.resolve(new this.Entry(KEYCHAIN_SERVICE, name).getPassword() ?? undefined);
  }

  set(name: SecretName, value: string): Promise<void> {
    new this.Entry(KEYCHAIN_SERVICE, name).setPassword(value);
    return Promise.resolve();
  }

  delete(name: SecretName): Promise<boolean> {
    return Promise.resolve(new this.Entry(KEYCHAIN_SERVICE, name).deletePassword());
  }
}

/** JSON file readable only by the owner (0600). Used when no OS keychain is available. */
export class FileSecretBackend implements SecretBackend {
  readonly kind = 'file';
  constructor(readonly file: string) {}

  private async readAll(): Promise<Partial<Record<SecretName, string>>> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.file, 'utf8'));
      return typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }
  }

  private async writeAll(data: Partial<Record<SecretName, string>>): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tmp, this.file);
    await fs.chmod(this.file, 0o600);
  }

  async get(name: SecretName): Promise<string | undefined> {
    return (await this.readAll())[name];
  }

  async set(name: SecretName, value: string): Promise<void> {
    await this.writeAll({ ...(await this.readAll()), [name]: value });
  }

  async delete(name: SecretName): Promise<boolean> {
    const all = await this.readAll();
    if (!(name in all)) return false;
    Reflect.deleteProperty(all, name);
    await this.writeAll(all);
    return true;
  }
}

export interface ResolvedSecret {
  value: string;
  source: SecretSource;
}

/**
 * Resolves API keys: environment variables always win, then the OS keychain, then the 0600 file.
 * A keychain that errors (e.g. no Secret Service on a headless Linux box) is skipped, not fatal.
 */
export class SecretStore {
  constructor(
    private readonly backends: readonly SecretBackend[],
    private readonly env: Env,
  ) {}

  get storageKind(): SecretSource {
    return this.backends[0]?.kind ?? 'file';
  }

  async get(name: SecretName): Promise<ResolvedSecret | undefined> {
    const fromEnv = this.env[SECRET_ENV_VARS[name]];
    if (fromEnv !== undefined && fromEnv.trim() !== '')
      return { value: fromEnv.trim(), source: 'env' };
    for (const backend of this.backends) {
      try {
        const value = await backend.get(name);
        if (value !== undefined && value !== '') return { value, source: backend.kind };
      } catch {
        // try the next backend
      }
    }
    return undefined;
  }

  /** Stores in the first backend that accepts it and clears stale copies from the others. */
  async set(name: SecretName, value: string): Promise<SecretSource> {
    let lastError: unknown;
    for (const [i, backend] of this.backends.entries()) {
      try {
        await backend.set(name, value);
        for (const other of this.backends.slice(i + 1)) await other.delete(name).catch(() => false);
        return backend.kind;
      } catch (err) {
        lastError = err;
      }
    }
    throw new Error(`Could not store the ${name} key: ${String(lastError)}`);
  }

  async delete(name: SecretName): Promise<boolean> {
    let removed = false;
    for (const backend of this.backends) {
      removed = (await backend.delete(name).catch(() => false)) || removed;
    }
    return removed;
  }
}

/**
 * `VINAX_SECRETS_BACKEND=file` forces the file backend (tests, CI, standalone binaries).
 */
export async function openSecretStore(env: Env = process.env): Promise<SecretStore> {
  const file = new FileSecretBackend(path.join(vinaxHome(env), 'credentials.json'));
  if (env.VINAX_SECRETS_BACKEND === 'file') return new SecretStore([file], env);
  try {
    const mod = (await import('@napi-rs/keyring')) as { Entry: KeyringEntryCtor };
    return new SecretStore([new KeychainBackend(mod.Entry), file], env);
  } catch {
    return new SecretStore([file], env);
  }
}

export function maskSecret(value: string): string {
  return value.length <= 8 ? '••••' : `${value.slice(0, 4)}…${value.slice(-4)}`;
}
