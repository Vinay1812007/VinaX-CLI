import fs from 'node:fs';
import path from 'node:path';
import { vinaxHome, type Env } from '../config/paths.js';
import type { ModelRef, ProviderName, Usage } from '../providers/types.js';

export interface UsageCounts {
  requests: number;
  promptTokens: number;
  completionTokens: number;
}

export type ProviderUsage = Partial<
  Record<ProviderName, UsageCounts & { models: Record<string, UsageCounts> }>
>;

export interface DayUsage {
  date: string;
  providers: ProviderUsage;
}

/** Several days added up: what `/usage` shows for a week, or for everything VinaX has recorded. */
export interface UsageRollup {
  /** The days that had anything to count, oldest first. */
  dates: string[];
  providers: ProviderUsage;
}

// Runtimes are created freely by the CLI and by consumers of the core package. Keep one process
// exit listener instead of adding one per runtime, and only retain trackers that have data left
// to persist.
const pendingTrackers = new Set<UsageTracker>();
process.once('exit', () => {
  for (const tracker of pendingTrackers) tracker.flush();
});

function empty(): UsageCounts {
  return { requests: 0, promptTokens: 0, completionTokens: 0 };
}

/**
 * `Object.entries` for a partial record. TypeScript types the values as present, but these come
 * from a JSON file on disk, which may be anything.
 */
function entriesOf<V>(record: Partial<Record<ProviderName, V>>): [ProviderName, V | undefined][] {
  return Object.entries(record) as [ProviderName, V | undefined][];
}

function add(target: UsageCounts, delta: UsageCounts): void {
  target.requests += delta.requests;
  target.promptTokens += delta.promptTokens;
  target.completionTokens += delta.completionTokens;
}

/**
 * Requests and tokens used today, per provider and model, in `~/.vinax/usage/<date>.json`.
 * Counts are merged into the file on every flush, so several VinaX processes add up.
 */
export class UsageTracker {
  private pending = new Map<string, UsageCounts>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly env: Env,
    private readonly today: () => string = () => new Date().toISOString().slice(0, 10),
  ) {}

  private file(date: string): string {
    return path.join(vinaxHome(this.env), 'usage', `${date}.json`);
  }

  private bump(ref: ModelRef, delta: UsageCounts): void {
    const key = `${ref.provider}\u0000${ref.model}`;
    const current = this.pending.get(key) ?? empty();
    add(current, delta);
    this.pending.set(key, current);
    pendingTrackers.add(this);
    this.timer ??= setTimeout(() => {
      this.flush();
    }, 1000);
    this.timer.unref();
  }

  recordRequest(ref: ModelRef): void {
    this.bump(ref, { requests: 1, promptTokens: 0, completionTokens: 0 });
  }

  recordTokens(ref: ModelRef, usage: Usage): void {
    this.bump(ref, {
      requests: 0,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
    });
  }

  read(date: string = this.today()): DayUsage {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file(date), 'utf8')) as Partial<DayUsage>;
      if (parsed.providers !== undefined) return { date, providers: parsed.providers };
    } catch {
      // no usage yet today
    }
    return { date, providers: {} };
  }

  /** Writes pending counts; synchronous so it also works from an exit handler. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.pending.size === 0) {
      pendingTrackers.delete(this);
      return;
    }
    const date = this.today();
    const day = this.read(date);
    for (const [key, delta] of this.pending) {
      const [provider, model] = key.split('\u0000') as [ProviderName, string];
      const p = (day.providers[provider] ??= { ...empty(), models: {} });
      add(p, delta);
      add((p.models[model] ??= empty()), delta);
    }
    this.pending = new Map();
    try {
      fs.mkdirSync(path.dirname(this.file(date)), { recursive: true });
      fs.writeFileSync(this.file(date), `${JSON.stringify(day, null, 2)}\n`);
    } catch {
      // usage stats are best-effort
    } finally {
      pendingTrackers.delete(this);
    }
  }

  /** Pending plus stored counts for today. */
  snapshot(): DayUsage {
    this.flush();
    return this.read();
  }

  /** Every day VinaX has recorded, oldest first. */
  days(): string[] {
    try {
      return fs
        .readdirSync(path.join(vinaxHome(this.env), 'usage'))
        .flatMap((name) => (/^\d{4}-\d{2}-\d{2}\.json$/.test(name) ? [name.slice(0, 10)] : []))
        .sort();
    } catch {
      return [];
    }
  }

  /**
   * Days added up, from `since` (an ISO date) onwards, or everything when it is left out. Only
   * days that recorded something are listed. Pending counts are written first, so a rollup
   * includes what this session has done so far.
   */
  rollup(since?: string): UsageRollup {
    this.flush();
    const dates = this.days().filter((d) => since === undefined || d >= since);
    const providers: ProviderUsage = {};
    for (const date of dates) {
      for (const [name, counts] of entriesOf(this.read(date).providers)) {
        if (counts === undefined) continue;
        const into = (providers[name] ??= { ...empty(), models: {} });
        add(into, counts);
        for (const [model, c] of Object.entries(counts.models))
          add((into.models[model] ??= empty()), c);
      }
    }
    return { dates, providers };
  }
}

/** Requests and tokens across every provider in a rollup. */
export function usageTotals(providers: ProviderUsage): UsageCounts {
  const total = empty();
  for (const [, counts] of entriesOf(providers)) if (counts !== undefined) add(total, counts);
  return total;
}
