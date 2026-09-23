import fs from 'node:fs';
import path from 'node:path';
import { vinaxHome, type Env } from '../config/paths.js';
import type { ModelRef, ProviderName, Usage } from '../providers/types.js';

export interface UsageCounts {
  requests: number;
  promptTokens: number;
  completionTokens: number;
}

export interface DayUsage {
  date: string;
  providers: Partial<Record<ProviderName, UsageCounts & { models: Record<string, UsageCounts> }>>;
}

function empty(): UsageCounts {
  return { requests: 0, promptTokens: 0, completionTokens: 0 };
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
    if (this.pending.size === 0) return;
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
    }
  }

  /** Pending plus stored counts for today. */
  snapshot(): DayUsage {
    this.flush();
    return this.read();
  }
}
