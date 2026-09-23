import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { vinaxHome, type Env } from '../config/paths.js';

const stateSchema = z.object({
  onboardingComplete: z.boolean().default(false),
  trustedDirs: z.array(z.string()).default([]),
  /** Project MCP servers the user allowed to start, per project folder. */
  approvedMcp: z.record(z.string(), z.array(z.string())).default({}),
});

export type AppState = z.infer<typeof stateSchema>;

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Machine-local UI state in `~/.vinax/state.json`: whether onboarding ran and which folders the
 * user trusts. Not a settings file, so it is never merged with project settings.
 */
export class AppStateStore {
  readonly file: string;

  constructor(env: Env = process.env) {
    this.file = path.join(vinaxHome(env), 'state.json');
  }

  async read(): Promise<AppState> {
    try {
      const parsed = stateSchema.safeParse(JSON.parse(await fs.readFile(this.file, 'utf8')));
      if (parsed.success) return parsed.data;
    } catch {
      // missing or corrupt: start fresh
    }
    return stateSchema.parse({});
  }

  private async write(state: AppState): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, this.file);
  }

  async update(mutate: (s: AppState) => AppState): Promise<AppState> {
    const next = mutate(await this.read());
    await this.write(next);
    return next;
  }

  /** A folder is trusted if it, or any folder above it, was trusted. */
  async isTrusted(dir: string): Promise<boolean> {
    const target = path.resolve(dir);
    return (await this.read()).trustedDirs.some((t) => isInside(target, t));
  }

  async isMcpApproved(dir: string, server: string): Promise<boolean> {
    return ((await this.read()).approvedMcp[path.resolve(dir)] ?? []).includes(server);
  }

  async approveMcp(dir: string, server: string): Promise<void> {
    const key = path.resolve(dir);
    await this.update((s) => {
      const list = s.approvedMcp[key] ?? [];
      return list.includes(server)
        ? s
        : { ...s, approvedMcp: { ...s.approvedMcp, [key]: [...list, server] } };
    });
  }

  async trust(dir: string): Promise<void> {
    const target = path.resolve(dir);
    await this.update((s) => ({
      ...s,
      trustedDirs: s.trustedDirs.includes(target) ? s.trustedDirs : [...s.trustedDirs, target],
    }));
  }
}
