import fs from 'node:fs';
import path from 'node:path';

const KEY_PATTERNS: readonly RegExp[] = [
  /gsk_[A-Za-z0-9]{8,}/g, // Groq
  /sk-or-[A-Za-z0-9-]{8,}/g, // OpenRouter
  /sk-[A-Za-z0-9_-]{16,}/g, // generic OpenAI-style
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
];

/** Removes API keys from text: known key shapes, bearer tokens and any explicitly listed secret. */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 6) out = out.split(secret).join('[REDACTED]');
  }
  for (const pattern of KEY_PATTERNS) {
    out = out.replace(pattern, (_match, prefix: unknown) =>
      typeof prefix === 'string' ? `${prefix}[REDACTED]` : '[REDACTED]',
    );
  }
  return out;
}

export interface Logger {
  readonly file: string | undefined;
  debug(event: string, data?: Record<string, unknown>): void;
  /** Registers a secret value to scrub from every later log line. */
  addSecret(value: string): void;
}

export const noopLogger: Logger = {
  file: undefined,
  debug: () => undefined,
  addSecret: () => undefined,
};

/** Appends one JSON object per line to `<dir>/debug-YYYY-MM-DD.log`. Never throws. */
export function createFileLogger(dir: string, now: () => Date = () => new Date()): Logger {
  const file = path.join(dir, `debug-${now().toISOString().slice(0, 10)}.log`);
  const secrets: string[] = [];
  let ready = false;
  return {
    file,
    addSecret: (value) => {
      secrets.push(value);
    },
    debug(event, data) {
      try {
        if (!ready) {
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
          ready = true;
        }
        const line = JSON.stringify({ ts: now().toISOString(), pid: process.pid, event, ...data });
        fs.appendFileSync(file, `${redact(line, secrets)}\n`, { mode: 0o600 });
      } catch {
        // debug logging must never break a run
      }
    },
  };
}
