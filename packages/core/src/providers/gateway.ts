/** Shown while a sleeping gateway starts up (Render free services sleep after 15 idle minutes). */
export const GATEWAY_WAKING =
  'Waking VinaX gateway… free servers sleep when idle; this can take a minute';

/** A request within this window means the gateway cannot have gone back to sleep yet. */
const AWAKE_MS = 10 * 60_000;
/** A gateway that just failed to wake is not waited on again right away. */
const FAILED_MS = 30_000;
const PROBE_MS = 3_000;
const POLL_MS = 3_000;

export class GatewayUnavailableError extends Error {
  override name = 'GatewayUnavailableError';
}

export type GatewayProbe = { ok: true; version?: string } | { ok: false; reason: string };

export interface GatewayClientOptions {
  /** Longest wait for the gateway to wake up. */
  timeoutMs: number;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function describe(err: unknown): string {
  if (err instanceof Error && err.name === 'TimeoutError') return 'no answer';
  return err instanceof Error ? err.message : String(err);
}

/**
 * The optional VinaX gateway (`vinax login --gateway`). It relays chat completions for providers
 * the user has no key for. This client knows whether the gateway is awake and can wake it.
 */
export class GatewayClient {
  readonly url: string;
  private lastOk = Number.NEGATIVE_INFINITY;
  private lastFailure = Number.NEGATIVE_INFINITY;
  private waking: Promise<void> | undefined;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    url: string,
    private readonly opts: GatewayClientOptions,
  ) {
    this.url = url.replace(/\/+$/, '');
    this.fetch = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.sleep =
      opts.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }));
  }

  get baseURL(): string {
    return `${this.url}/v1`;
  }

  get timeoutMs(): number {
    return this.opts.timeoutMs;
  }

  isAwake(): boolean {
    return this.now() - this.lastOk < AWAKE_MS;
  }

  /** Records a successful request. */
  markOk(): void {
    this.lastOk = this.now();
  }

  /** One `GET /health`, with a short timeout. */
  async probe(timeoutMs = PROBE_MS, signal?: AbortSignal): Promise<GatewayProbe> {
    try {
      const timeout = AbortSignal.timeout(timeoutMs);
      const res = await this.fetch(`${this.url}/health`, {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!res.ok) return { ok: false, reason: `HTTP ${String(res.status)}` };
      const body = (await res.json().catch(() => ({}))) as { version?: unknown };
      this.markOk();
      return typeof body.version === 'string' ? { ok: true, version: body.version } : { ok: true };
    } catch (err) {
      if (signal?.aborted === true) throw err;
      return { ok: false, reason: describe(err) };
    }
  }

  /**
   * Resolves once the gateway answers `/health`, polling until `timeoutMs` has passed. Concurrent
   * callers share one wake-up. Throws GatewayUnavailableError when it never answers.
   */
  wake(signal?: AbortSignal): Promise<void> {
    if (this.isAwake()) return Promise.resolve();
    if (this.now() - this.lastFailure < FAILED_MS) {
      return Promise.reject(
        new GatewayUnavailableError(`The VinaX gateway at ${this.url} is not responding.`),
      );
    }
    this.waking ??= this.poll().finally(() => {
      this.waking = undefined;
    });
    if (!signal) return this.waking;
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      this.waking?.then(resolve, reject).finally(() => {
        signal.removeEventListener('abort', onAbort);
      });
    });
  }

  private async poll(): Promise<void> {
    const deadline = this.now() + this.opts.timeoutMs;
    let reason = 'no answer';
    while (this.now() < deadline) {
      const r = await this.probe(Math.max(1000, Math.min(30_000, deadline - this.now())));
      if (r.ok) return;
      reason = r.reason;
      if (this.now() + POLL_MS >= deadline) break;
      await this.sleep(POLL_MS);
    }
    this.lastFailure = this.now();
    throw new GatewayUnavailableError(
      `The VinaX gateway at ${this.url} did not wake up within ${String(Math.round(this.opts.timeoutMs / 1000))}s (${reason}).`,
    );
  }
}

export type GatewayCheck =
  { ok: true; version?: string; models: number } | { ok: false; rejected: boolean; reason: string };

/** Refuses plain http except for local addresses, where a token would not cross the network. */
export function gatewayUrlProblem(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'that is not a URL (expected e.g. https://vinax-gateway.onrender.com)';
  }
  if (url.protocol === 'https:') return undefined;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol === 'http:' && local) return undefined;
  return 'the gateway URL must use https:// (plain http is only allowed for localhost)';
}

/**
 * Wakes the gateway if needed (calling `onWaking` first) and checks the token against
 * `/v1/models`. Used by `vinax login --gateway`, /login and onboarding.
 */
export async function checkGateway(
  url: string,
  token: string,
  opts: { timeoutMs: number; onWaking?: () => void; fetch?: typeof fetch; signal?: AbortSignal },
): Promise<GatewayCheck> {
  const problem = gatewayUrlProblem(url);
  if (problem !== undefined) return { ok: false, rejected: true, reason: problem };
  const client = new GatewayClient(url, {
    timeoutMs: opts.timeoutMs,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  let probe = await client.probe(PROBE_MS, opts.signal);
  if (!probe.ok) {
    opts.onWaking?.();
    try {
      await client.wake(opts.signal);
    } catch (err) {
      if (err instanceof GatewayUnavailableError)
        return { ok: false, rejected: false, reason: err.message };
      throw err;
    }
    probe = await client.probe(10_000, opts.signal);
  }
  try {
    const res = await (opts.fetch ?? fetch)(`${client.baseURL}/models`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: opts.signal
        ? AbortSignal.any([opts.signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
    });
    if (res.status === 401 || res.status === 403)
      return { ok: false, rejected: true, reason: 'the gateway rejected that token' };
    if (!res.ok)
      return {
        ok: false,
        rejected: false,
        reason: `the gateway answered HTTP ${String(res.status)}`,
      };
    const body = (await res.json().catch(() => ({}))) as { data?: unknown };
    const models = Array.isArray(body.data) ? body.data.length : 0;
    return {
      ok: true,
      models,
      ...(probe.ok && probe.version !== undefined ? { version: probe.version } : {}),
    };
  } catch (err) {
    if (opts.signal?.aborted === true) throw err;
    return { ok: false, rejected: false, reason: `could not reach the gateway (${describe(err)})` };
  }
}
