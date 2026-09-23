/**
 * Creates a client token for the gateway:
 *
 *   pnpm gateway:token alice
 *
 * Give the token to the user (they run `vinax login --gateway <url>`), and append the printed
 * `name:hash` entry to the service's VINAX_TOKEN_HASHES variable. The token itself is not stored.
 */
import { generateToken, hashToken } from './tokens.js';

const name = (process.argv[2] ?? 'user').replace(/[^A-Za-z0-9_.-]/g, '_');
const token = generateToken();
console.log(`Token for ${name} (give this to the user; it is shown only once):\n\n  ${token}\n`);
console.log(
  `Add this entry to VINAX_TOKEN_HASHES (comma-separated):\n\n  ${name}:${hashToken(token)}\n`,
);
