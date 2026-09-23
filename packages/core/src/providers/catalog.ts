import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ModelInfo, Provider, ProviderName } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const cacheSchema = z.object({
  fetchedAt: z.number(),
  models: z.array(
    z.object({
      id: z.string(),
      contextWindow: z.number().optional(),
      supportsTools: z.boolean().optional(),
      free: z.boolean(),
    }),
  ),
});

export interface CatalogResult {
  models: ModelInfo[];
  fetchedAt: number;
  /** True when a refresh failed and an expired cache was used instead. */
  stale: boolean;
}

/** `/models` per provider, cached on disk for 24 hours. */
export class ModelCatalog {
  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = DAY_MS,
  ) {}

  private file(provider: ProviderName): string {
    return path.join(this.dir, `models-${provider}.json`);
  }

  private async readCache(provider: ProviderName): Promise<CatalogResult | undefined> {
    try {
      const parsed = cacheSchema.safeParse(
        JSON.parse(await fs.readFile(this.file(provider), 'utf8')),
      );
      if (!parsed.success) return undefined;
      return {
        fetchedAt: parsed.data.fetchedAt,
        stale: false,
        models: parsed.data.models.map((m) => ({
          id: m.id,
          contextWindow: m.contextWindow,
          supportsTools: m.supportsTools,
          free: m.free,
        })),
      };
    } catch {
      return undefined;
    }
  }

  async get(
    provider: Provider,
    opts: { refresh?: boolean; signal?: AbortSignal } = {},
  ): Promise<CatalogResult> {
    const cached = await this.readCache(provider.name);
    if (cached && opts.refresh !== true && this.now() - cached.fetchedAt < this.ttlMs)
      return cached;
    try {
      const models = await provider.listModels(opts.signal);
      const fetchedAt = this.now();
      await fs.mkdir(this.dir, { recursive: true });
      await fs.writeFile(this.file(provider.name), JSON.stringify({ fetchedAt, models }), 'utf8');
      return { models, fetchedAt, stale: false };
    } catch (err) {
      if (cached) return { ...cached, stale: true };
      throw err;
    }
  }
}
