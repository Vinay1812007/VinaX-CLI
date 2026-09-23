/**
 * Exponential backoff with "equal jitter": half the delay is fixed, half is random, so retries
 * from many clients spread out without ever collapsing to zero.
 */
export function backoffDelay(
  attempt: number,
  opts: { baseMs: number; maxMs: number },
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(opts.maxMs, opts.baseMs * 2 ** attempt);
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

export class AbortError extends Error {
  constructor() {
    super('Aborted');
    this.name = 'AbortError';
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new AbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
