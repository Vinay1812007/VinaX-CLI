import fs from 'node:fs/promises';
import path from 'node:path';
import { AppStateStore, cacheDir, PROJECT_URL, type Env } from '@vinax/core';
import { compareVersions, latestRelease } from './update.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 5000;

/** Something to show when the interactive session starts. */
export type Announcement =
  | { kind: 'notice'; level: 'info' | 'warning'; text: string }
  | { kind: 'panel'; title: string; markdown: string };

export function releaseUrl(version: string): string {
  return `${PROJECT_URL}/releases/tag/v${version}`;
}

/** `CI` or `VINAX_NO_UPDATE_CHECK` turn the background update check off. */
export function updateCheckDisabled(env: Env): boolean {
  const off = (v: string | undefined) => v !== undefined && v !== '' && v !== '0' && v !== 'false';
  return off(env.VINAX_NO_UPDATE_CHECK) || off(env.CI);
}

/**
 * The newest released version when it is newer than `current`, else `undefined`. The answer is
 * cached for a day in `~/.vinax/cache/update-check.json`; any failure just means "no news".
 */
export async function checkForUpdate(opts: {
  current: string;
  env: Env;
  now?: () => number;
  fetchFn?: typeof fetch;
}): Promise<string | undefined> {
  if (updateCheckDisabled(opts.env)) return undefined;
  const now = opts.now ?? Date.now;
  const file = path.join(cacheDir(opts.env), 'update-check.json');
  let latest: string | undefined;
  try {
    const cached = JSON.parse(await fs.readFile(file, 'utf8')) as {
      checkedAt?: unknown;
      latest?: unknown;
    };
    if (
      typeof cached.checkedAt === 'number' &&
      typeof cached.latest === 'string' &&
      now() - cached.checkedAt < DAY_MS
    )
      latest = cached.latest;
  } catch {
    // no cache yet
  }
  if (latest === undefined) {
    try {
      const release = await Promise.race([
        latestRelease(opts.env, opts.fetchFn),
        new Promise<never>((_, reject) =>
          setTimeout(() => {
            reject(new Error('timeout'));
          }, CHECK_TIMEOUT_MS).unref(),
        ),
      ]);
      latest = release.version;
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify({ checkedAt: now(), latest }), 'utf8');
    } catch {
      return undefined;
    }
  }
  return compareVersions(latest, opts.current) > 0 ? latest : undefined;
}

/** The package changelog shipped next to the CLI (absent in standalone binaries). */
export async function readChangelog(): Promise<string | undefined> {
  for (const rel of ['../CHANGELOG.md', '../../CHANGELOG.md']) {
    try {
      return await fs.readFile(new URL(rel, import.meta.url), 'utf8');
    } catch {
      // try the next location
    }
  }
  return undefined;
}

/**
 * Bullet points for versions after `from` up to and including `to`, newest first, from a
 * changesets CHANGELOG.md. Commit hashes are dropped; nested bullets are kept.
 */
export function releaseNotes(
  changelog: string,
  from: string | undefined,
  to: string,
  max = 10,
): { version: string; bullets: string[] }[] {
  const out: { version: string; bullets: string[] }[] = [];
  let current: { version: string; bullets: string[] } | undefined;
  for (const line of changelog.split('\n')) {
    const heading = /^## (\d+\.\d+\.\d+\S*)\s*$/.exec(line);
    if (heading?.[1] !== undefined) {
      const v = heading[1];
      const wanted =
        compareVersions(v, to) <= 0 && (from === undefined || compareVersions(v, from) > 0);
      current = wanted ? { version: v, bullets: [] } : undefined;
      if (current) out.push(current);
      continue;
    }
    if (!current) continue;
    const top = /^- (?:[0-9a-f]{7,}: )?(.+)$/.exec(line);
    const nested = /^ {2}- (.+)$/.exec(line);
    if (top?.[1] !== undefined) current.bullets.push(`- ${top[1]}`);
    else if (nested?.[1] !== undefined) current.bullets.push(`  - ${nested[1]}`);
  }
  let left = max;
  return out
    .map((r) => {
      const bullets = r.bullets.slice(0, Math.max(0, left));
      left -= bullets.length;
      return { version: r.version, bullets };
    })
    .filter((r) => r.bullets.length > 0);
}

export function notesMarkdown(notes: { version: string; bullets: string[] }[]): string {
  return notes.map((n) => `**v${n.version}**\n\n${n.bullets.join('\n')}`).join('\n\n');
}

/**
 * What to tell the user at startup: what's new since the version that last ran, and whether a
 * newer release is out. Records the running version so the notes show once.
 */
export async function startupAnnouncements(opts: {
  current: string;
  env: Env;
  fetchFn?: typeof fetch;
  changelog?: () => Promise<string | undefined>;
}): Promise<Announcement[]> {
  const out: Announcement[] = [];
  const state = new AppStateStore(opts.env);
  try {
    const last = (await state.read()).lastVersion;
    if (last !== opts.current) await state.update((s) => ({ ...s, lastVersion: opts.current }));
    if (last !== undefined && compareVersions(opts.current, last) > 0) {
      const text = await (opts.changelog ?? readChangelog)();
      const notes = text === undefined ? [] : releaseNotes(text, last, opts.current, 8);
      out.push({
        kind: 'panel',
        title: `VinaX updated: v${last} → v${opts.current}`,
        markdown: [
          ...(notes.length === 0 ? [] : [notesMarkdown(notes), '']),
          `Full release notes: ${releaseUrl(opts.current)} · \`/changelog\` shows them any time.`,
        ].join('\n'),
      });
    }
  } catch {
    // state is a convenience; never block startup on it
  }
  const latest = await checkForUpdate({
    current: opts.current,
    env: opts.env,
    ...(opts.fetchFn === undefined ? {} : { fetchFn: opts.fetchFn }),
  });
  if (latest !== undefined) {
    out.push({
      kind: 'notice',
      level: 'warning',
      text: `Update available: v${opts.current} → v${latest}. Run \`vinax update\` (or /update for details).`,
    });
  }
  return out;
}
