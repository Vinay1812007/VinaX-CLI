import { createHash, randomBytes } from 'node:crypto';

const TOKEN_PREFIX = 'vxg_';

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** A new random client token. Only its hash is stored on the server. */
export function generateToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`;
}

/**
 * Parses `VINAX_TOKEN_HASHES`: comma- or newline-separated `name:sha256hex` entries (a bare hash
 * gets a numbered name). Returns hash → name.
 */
export function parseTokenHashes(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  const entries = raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
  entries.forEach((entry, i) => {
    const sep = entry.lastIndexOf(':');
    const name = sep === -1 ? `token${String(i + 1)}` : entry.slice(0, sep).trim();
    const hash = (sep === -1 ? entry : entry.slice(sep + 1)).trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash))
      throw new Error(`VINAX_TOKEN_HASHES entry "${name}" is not a sha256 hex digest`);
    out.set(hash, name);
  });
  return out;
}
