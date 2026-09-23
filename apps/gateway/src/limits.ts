const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

interface Usage {
  /** Request times within the last minute. */
  recent: number[];
  day: number;
  dayCount: number;
}

export type LimitDecision = { ok: true } | { ok: false; retryAfterSec: number; reason: string };

/** Per-token request limits kept in memory (they reset when the service restarts). */
export class RateLimiter {
  private readonly usage = new Map<string, Usage>();

  constructor(
    private readonly rpm: number,
    private readonly rpd: number,
    private readonly now: () => number = Date.now,
  ) {}

  take(token: string): LimitDecision {
    const now = this.now();
    const day = Math.floor(now / DAY);
    const u = this.usage.get(token) ?? { recent: [], day, dayCount: 0 };
    if (u.day !== day) {
      u.day = day;
      u.dayCount = 0;
    }
    u.recent = u.recent.filter((t) => now - t < MINUTE);
    this.usage.set(token, u);
    if (u.dayCount >= this.rpd) {
      return {
        ok: false,
        retryAfterSec: Math.ceil(((day + 1) * DAY - now) / 1000),
        reason: `daily limit of ${String(this.rpd)} requests reached`,
      };
    }
    const oldest = u.recent[0];
    if (u.recent.length >= this.rpm && oldest !== undefined) {
      return {
        ok: false,
        retryAfterSec: Math.max(1, Math.ceil((oldest + MINUTE - now) / 1000)),
        reason: `limit of ${String(this.rpm)} requests per minute reached`,
      };
    }
    u.recent.push(now);
    u.dayCount++;
    return { ok: true };
  }
}
