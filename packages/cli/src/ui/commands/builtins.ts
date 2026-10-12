import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AppStateStore,
  conversationMarkdown,
  costOf,
  createProvider,
  formatCost,
  priceFor,
  totalTokens,
  formatModelRef,
  HOOK_EVENTS,
  KNOWN_MODELS,
  modelAlias,
  noopLogger,
  openSecretStore,
  parseModelRef,
  PROJECT_URL,
  PROVIDER_NAMES,
  providerHost,
  providerKeyPage,
  providerLabel,
  RateLimitLedger,
  runDoctor,
  SECRET_ENV_VARS,
  settingsPaths,
  THEME_NAMES,
  updateSettingsFile,
  usageTotals,
  type ModelUsage,
  type Price,
  type ProviderName,
  type ProviderUsage,
  type UsageRollup,
} from '@vinax/core';
import { CHECK_ICON, healthMarkdown } from '../../health.js';
import { openInBrowser } from '../../open-url.js';
import { compareVersions, detectInstall, latestRelease } from '../../update.js';
import { notesMarkdown, readChangelog, releaseNotes, releaseUrl } from '../../updates.js';
import { VERSION } from '../../version.js';
import { gatewayLacks, modelSelectItems, providerSummaries } from '../model-items.js';
import { sessionItems } from '../sessions.js';
import {
  MAZE_LABELS,
  prefsFromState,
  snakeSession,
  stateFromPrefs,
  topScore,
  type SnakeSession,
} from '../snake.js';
import { formatTokens, shortenPath } from '../format.js';
import { THEME_LABELS } from '../theme.js';
import { sessionStore } from '../../session.js';
import {
  copy,
  effort,
  openPermissions,
  outputStyle,
  permissionsCommand,
  settingsCommand,
  skills,
} from './extra.js';
import { plugin } from './plugins.js';
import type { CommandContext, SlashCommand } from './types.js';

const INIT_PROMPT = `Study this codebase and write a VINAX.md file in the project root that will help future VinaX sessions work here. Cover:
1. How to build, test, lint and run it — exact commands, including how to run a single test.
2. A short architecture overview: the big picture that takes reading several files to understand.
3. Conventions that are not obvious from the code (naming, error handling, where things go).
Keep it under 60 lines, factual and specific to this project — no generic advice. If VINAX.md already exists, improve it instead of starting over. Fold in anything useful from README.md, AGENTS.md or other assistant rule files.`;

function plural(n: number, word: string): string {
  return `${String(n)} ${word}${n === 1 ? '' : 's'}`;
}

async function saveUserSetting(ctx: CommandContext, key: string, value: unknown): Promise<void> {
  await updateSettingsFile({ cwd: ctx.runtime.cwd, env: ctx.runtime.env, scope: 'user' }, (s) => ({
    ...s,
    [key]: value,
  }));
}

const help: SlashCommand = {
  name: 'help',
  description: 'Show commands and keyboard shortcuts',
  source: 'builtin',
  run(ctx) {
    const rows = ctx
      .commands()
      .map(
        (c) =>
          `| \`/${c.name}${c.argumentHint === undefined ? '' : ` ${c.argumentHint}`}\` | ${c.description}${c.source === 'builtin' ? '' : ` _(${c.source})_`} |`,
      );
    ctx.panel(
      'VinaX help',
      [
        '| Command | What it does |',
        '|---|---|',
        ...rows,
        '',
        '**Prefixes:** `/` commands · `@path` attach a file or folder · `!cmd` run a shell command · `#note` save a note to memory',
        '',
        'Press `?` on an empty prompt for keyboard shortcuts, `Ctrl+P` to search commands and views, `Ctrl+G` to review changed files and `Ctrl+O` to search the transcript. Custom commands live in `.vinax/commands/*.md` and `~/.vinax/commands/*.md`.',
      ].join('\n'),
    );
  },
};

const clear: SlashCommand = {
  name: 'clear',
  aliases: ['new'],
  description: 'Start a new conversation (the current one stays in /resume)',
  source: 'builtin',
  run: (ctx) => {
    ctx.clear();
  },
};

const compact: SlashCommand = {
  name: 'compact',
  argumentHint: '[focus]',
  description: 'Summarize the conversation so far to free up context',
  source: 'builtin',
  async run(ctx) {
    const result = await ctx.busy('Compacting the conversation', (signal) =>
      ctx.setup.agent.compact({
        mode: ctx.mode(),
        signal,
        force: true,
        ...(ctx.args === '' ? {} : { instructions: ctx.args }),
      }),
    );
    if (result === undefined) ctx.notice('info', 'Nothing to compact yet.');
    else
      ctx.notice(
        'info',
        `Compacted the conversation: ~${formatTokens(result.before)} → ~${formatTokens(result.after)} tokens.`,
      );
  },
};

/** Switches this session's model and says how to make it the default. */
function switchModel(ctx: CommandContext, input: string): void {
  if (input.trim().toLowerCase() === 'auto') {
    ctx.setup.agent.setModel('auto');
    ctx.session.record({ type: 'model', model: 'auto' });
    // Read it back: the getter resolves `auto` to the head of the chain the router would use, so
    // this names the model the next turn actually goes to rather than leaving it a mystery.
    const picked = ctx.setup.agent.model;
    ctx.notice(
      'info',
      `Auto model selection enabled: free models are preferred, and VinaX falls back when one is rate-limited or unavailable.${picked === undefined ? '' : ` Starting with \`${picked}\`.`} Provider billing still applies.`,
    );
    return;
  }
  let ref: string;
  try {
    ref = formatModelRef(parseModelRef(input));
  } catch (err) {
    ctx.notice('error', err instanceof Error ? err.message : String(err));
    return;
  }
  const { provider } = parseModelRef(ref);
  ctx.setup.agent.setModel(ref);
  ctx.session.record({ type: 'model', model: ref });
  const alias = modelAlias(ref);
  const warnings: string[] = [];
  if (!ctx.runtime.providers.has(provider))
    warnings.push(
      `there is no ${providerLabel(provider)} key yet — add one with /login or set ${SECRET_ENV_VARS[provider]}`,
    );
  else if (gatewayLacks(ctx.runtime, provider))
    warnings.push(
      `your VinaX gateway does not serve ${providerLabel(provider)} — add your own key with /login or set ${SECRET_ENV_VARS[provider]}`,
    );
  else if (ctx.runtime.skipped.has(ref))
    warnings.push(`it is not in ${providerLabel(provider)}'s model list, so it will be skipped`);
  ctx.notice(
    warnings.length === 0 ? 'info' : 'warning',
    `Using ${ref}${alias === undefined ? '' : ` (${alias})`} for this session${warnings.length === 0 ? '' : `, but ${warnings.join(' and ')}`}. To make it the default: vinax config set model ${alias ?? ref}`,
  );
}

async function pickModel(ctx: CommandContext, title: string): Promise<string | undefined> {
  const current = ctx.setup.agent.model ?? ctx.runtime.settings.resolved.model;
  const items = [
    {
      label: 'Auto',
      value: 'auto',
      hint: 'Prefer free models, fall back automatically · provider billing applies',
      current: ctx.setup.agent.modelSelection === 'auto',
    },
    ...modelSelectItems(ctx.runtime, current).map((item) => ({
      ...item,
      current: ctx.setup.agent.modelSelection === 'auto' ? false : item.current,
    })),
  ];
  if (!items.some((i) => i.disabled !== true)) {
    ctx.notice(
      'warning',
      'No model list is available. Add a key with /login, or use /model <provider:model>.',
    );
    return undefined;
  }
  const ref = await ctx.pick(title, items, { searchable: true });
  return ref === undefined || ref === '' ? undefined : ref;
}

const model: SlashCommand = {
  name: 'model',
  argumentHint: '[auto | provider:model | alias]',
  description: 'Switch the model for this session',
  source: 'builtin',
  async run(ctx) {
    const ref = ctx.args === '' ? await pickModel(ctx, 'Model for this session') : ctx.args;
    if (ref !== undefined) switchModel(ctx, ref);
  },
};

const models: SlashCommand = {
  name: 'models',
  description: 'Browse providers, models, aliases and the fallback order',
  source: 'builtin',
  async run(ctx) {
    const { runtime } = ctx;
    const r = runtime.settings.resolved;
    const current = ctx.setup.agent.model ?? r.model;
    const currentRef = parseModelRef(current);
    const alias = modelAlias(current);
    const lines: string[] = [
      `**Current** \`${current}\`${alias === undefined ? '' : ` · alias \`${alias}\``} · ${providerLabel(currentRef.provider)}`,
      '',
      '**Providers**',
    ];
    for (const p of providerSummaries(runtime)) {
      const state = gatewayLacks(runtime, p.provider)
        ? `not served by your VinaX gateway — add your own key with /login or ${SECRET_ENV_VARS[p.provider]}`
        : p.viaGateway
          ? 'via the VinaX gateway'
          : p.configured
            ? 'key configured'
            : `not configured — /login or ${SECRET_ENV_VARS[p.provider]}`;
      const lacking = gatewayLacks(runtime, p.provider);
      const size =
        lacking || p.catalogSize === undefined
          ? p.configured && !lacking
            ? ' · catalog unavailable'
            : ''
          : ` · ${plural(p.catalogSize, 'model')} in catalog`;
      lines.push(
        `- ${p.configured && !lacking ? '✔' : '○'} **${providerLabel(p.provider)}** _${providerHost(p.provider)}_ — ${state}${size}`,
      );
    }
    lines.push('', '**Fallback order**');
    const chain = [...new Set([current, ...r.fallbackChain])];
    for (const [i, ref] of chain.entries()) {
      const { provider } = parseModelRef(ref);
      const status = !runtime.providers.has(provider)
        ? 'no key'
        : gatewayLacks(runtime, provider)
          ? 'skipped: not served by your gateway'
          : runtime.skipped.has(ref)
            ? 'skipped: not in catalog'
            : 'ready';
      const a = modelAlias(ref);
      lines.push(`${String(i + 1)}. \`${ref}\`${a === undefined ? '' : ` (${a})`} — ${status}`);
    }
    lines.push(
      '',
      '**Special-purpose models**',
      `- Small (titles, summaries, compaction): \`${r.smallModel}\``,
      `- Plan mode: ${r.planModel === undefined ? 'the main model — set `planModel` to use a stronger one for planning' : `\`${r.planModel}\``}`,
    );
    lines.push('', '**Aliases**');
    for (const k of KNOWN_MODELS)
      if (k.alias !== undefined)
        lines.push(`- \`${k.alias}\` → \`${k.provider}:${k.model}\` · ${k.label}`);
    lines.push(
      '',
      r.freeModelsOnly
        ? 'Listing free and free-tier models only. `vinax config set freeModelsOnly false` lists paid ones too; `/model <provider:model>` still accepts any model by name.'
        : 'Listing every model, free and paid. `vinax config set freeModelsOnly true` hides the paid ones.',
      '',
      'Change the default with `vinax config set model <ref|alias>` and the order with `fallbackChain` in settings. `/model auto` prefers free models and falls back on its own.',
    );
    ctx.panel('Models', lines.join('\n'));
    const ref = await pickModel(ctx, 'Switch model? (Esc keeps the current one)');
    if (ref !== undefined && ref !== current) switchModel(ctx, ref);
  },
};

/** The effective settings as JSON, and where they come from (from /settings). */
const showEffectiveSettings = (ctx: CommandContext): void => {
  const r = ctx.runtime.settings.resolved;
  const paths = settingsPaths(ctx.runtime.cwd, ctx.runtime.env);
  ctx.panel(
    'Settings',
    [
      '```json',
      JSON.stringify(
        {
          model: r.model,
          smallModel: r.smallModel,
          ...(r.planModel === undefined ? {} : { planModel: r.planModel }),
          fallbackChain: r.fallbackChain,
          theme: r.theme,
          editorMode: r.editorMode,
          context: r.context,
          router: r.router,
        },
        null,
        2,
      ),
      '```',
      '',
      `- user: \`${shortenPath(paths.user)}\``,
      `- project: \`${shortenPath(paths.project)}\``,
      `- local: \`${shortenPath(paths.local)}\``,
      '',
      'Change these with `/settings`, or `vinax config set <key> <value>` (see `vinax config --help`).',
    ].join('\n'),
  );
};

const init: SlashCommand = {
  name: 'init',
  description: 'Analyze the project and write a starter VINAX.md',
  source: 'builtin',
  run(ctx) {
    ctx.send(INIT_PROMPT, { display: '/init' });
  },
};

const memory: SlashCommand = {
  name: 'memory',
  description: 'Edit a memory file (VINAX.md) in your editor',
  source: 'builtin',
  async run(ctx) {
    const mem = ctx.setup.memory;
    const known = new Map<string, string>();
    known.set(mem.noteTarget('project'), 'Project memory');
    known.set(mem.noteTarget('user'), 'Your personal memory (all projects)');
    for (const f of mem.files)
      if (!known.has(f.path))
        known.set(f.path, f.scope === 'nested' ? 'Folder memory' : 'Project memory');
    const file = await ctx.pick(
      'Which memory file?',
      [...known].map(([p, label]) => ({ label: `${label} — ${shortenPath(p)}`, value: p })),
    );
    if (file === undefined) return;
    try {
      await fs.access(file);
    } catch {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, '# Instructions for VinaX\n\n', 'utf8');
    }
    const editor =
      ctx.runtime.env.VISUAL ??
      ctx.runtime.env.EDITOR ??
      (process.platform === 'win32' ? 'notepad' : 'vi');
    await ctx.suspend(() => {
      spawnSync(`${editor} ${JSON.stringify(file)}`, { stdio: 'inherit', shell: true });
    });
    mem.reload();
    ctx.notice('info', `Reloaded ${shortenPath(file)}.`);
  },
};

const resume: SlashCommand = {
  name: 'resume',
  description: 'Continue an earlier conversation in this folder',
  source: 'builtin',
  async run(ctx) {
    const sessions = sessionStore(ctx.runtime)
      .list()
      .filter((s) => s.id !== ctx.session.id);
    if (sessions.length === 0) {
      ctx.notice('info', 'There are no other sessions in this folder yet.');
      return;
    }
    const id = await ctx.pick('Resume which conversation?', sessionItems(sessions), {
      searchable: true,
    });
    if (id !== undefined) ctx.resume(id);
  },
};

const rewind: SlashCommand = {
  name: 'rewind',
  description: 'Go back to an earlier prompt, restoring files and/or the conversation',
  source: 'builtin',
  run(ctx) {
    ctx.openRewind();
  },
};

const changes: SlashCommand = {
  name: 'changes',
  aliases: ['diff'],
  description: 'Review files changed this session: diffs, and undo per file (Ctrl+G)',
  source: 'builtin',
  run(ctx) {
    ctx.openChanges();
  },
};

const BAR_WIDTH = 22;

/**
 * A proportional bar. Panels render Markdown, which carries no per-slice colour, so each row gets
 * its own bar instead of one colour-coded grid. Anything non-zero keeps at least one block so a
 * small-but-present slice never looks empty.
 */
function bar(share: number, width = BAR_WIDTH): string {
  if (!Number.isFinite(share) || share <= 0) return '░'.repeat(width);
  const filled = Math.min(width, Math.max(1, Math.round(share * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

const contextCommand: SlashCommand = {
  name: 'context',
  description: 'Show what is filling the context window',
  source: 'builtin',
  run(ctx) {
    const { runtime, setup } = ctx;
    const b = setup.agent.contextBreakdown(ctx.mode());
    const model = setup.agent.model ?? runtime.settings.resolved.model;
    const budgeted = Number.isFinite(b.limit);
    const share = (n: number) => (budgeted ? n / b.limit : 0);
    const pct = (n: number) => `${String(Math.round(share(n) * 100))}%`;
    const lines: string[] = [
      `**Model** \`${model}\``,
      '',
      budgeted
        ? `**${formatTokens(b.used)}** of **${formatTokens(b.limit)}** tokens · ${pct(b.used)} used`
        : `**${formatTokens(b.used)}** tokens · no context budget is configured`,
      '',
      '| Part | | Tokens | Share |',
      '| --- | --- | ---: | ---: |',
    ];
    const rows = b.slices.filter((s) => s.tokens > 0 || s.key === 'messages');
    for (const s of rows)
      lines.push(
        `| ${s.label} | \`${bar(share(s.tokens))}\` | ${formatTokens(s.tokens)} | ${pct(s.tokens)} |`,
      );
    if (budgeted) {
      const free = Math.max(0, b.limit - b.used);
      lines.push(`| Free | \`${bar(share(free))}\` | ${formatTokens(free)} | ${pct(free)} |`);
    }
    lines.push('');
    if (b.compactAt === undefined)
      lines.push(
        'Auto-compaction is off (`context.autoCompact`), so the conversation is never summarized for you. Use `/compact` before you run out.',
      );
    else if (b.used >= b.compactAt)
      lines.push(
        `Past the auto-compaction point (${formatTokens(b.compactAt)}): the next turn summarizes older history to make room.`,
      );
    else
      lines.push(
        `Auto-compaction starts at ${formatTokens(b.compactAt)} — **${formatTokens(b.compactAt - b.used)}** to go.`,
      );
    lines.push(
      '',
      'Counts are estimates (~3.5 characters per token) of the *next* request, so they move as the conversation grows. `/compact` summarizes now; `/clear` starts fresh.',
    );
    ctx.panel('Context', lines.join('\n'));
  },
};

const status: SlashCommand = {
  name: 'status',
  description: 'Session, providers and remaining rate limits',
  source: 'builtin',
  async run(ctx) {
    const { runtime, setup } = ctx;
    const lines: string[] = [
      `**Session** ${ctx.sessionTitle() ?? '(untitled)'} · \`${ctx.session.id}\``,
      `- model: \`${setup.agent.model ?? runtime.settings.resolved.model}\` · mode: ${ctx.mode()} · context: ${ctx.contextPct() === undefined ? 'n/a' : `${String(ctx.contextPct())}%`} of ${formatTokens(setup.contextLimit())} tokens`,
      `- memory: ${setup.memory.files.length === 0 ? 'none' : setup.memory.files.map((f) => `\`${shortenPath(f.path)}\``).join(', ')}`,
      `- output style: ${setup.outputStyle().name} — ${setup.outputStyle().description} (\`/output-style\`)`,
      '',
    ];
    const store = await openSecretStore(runtime.env);
    for (const name of PROVIDER_NAMES) {
      const secret = await store.get(name);
      const provider = runtime.providers.get(name);
      const route = runtime.viaGateway.has(name)
        ? `through the VinaX gateway (${runtime.gateway?.url ?? ''})`
        : provider
          ? `key from ${secret?.source ?? '?'}`
          : 'no key';
      lines.push(`**${providerLabel(name)}** — ${route}`);
      for (const [key, snap] of runtime.ledger
        .entries()
        .filter(([k]) => k.startsWith(`${name}:`))) {
        const parts: string[] = [];
        if (snap.tokens.limit !== undefined)
          parts.push(
            `${formatTokens(snap.tokens.remaining ?? 0)}/${formatTokens(snap.tokens.limit)} tokens/min`,
          );
        if (snap.requests.limit !== undefined)
          parts.push(
            `${String(snap.requests.remaining ?? '?')}/${String(snap.requests.limit)} requests`,
          );
        if (snap.blockedUntil !== undefined && snap.blockedUntil > Date.now())
          parts.push(
            `rate-limited for ${String(Math.ceil((snap.blockedUntil - Date.now()) / 1000))}s`,
          );
        lines.push(
          `- \`${key.slice(name.length + 1)}\`: ${parts.length === 0 ? 'no limit headers yet' : parts.join(' · ')}`,
        );
      }
      const info = await provider?.accountInfo?.(AbortSignal.timeout(8000));
      if (info) {
        const free =
          info.is_free_tier === 'true'
            ? 'free tier (50 :free requests/day)'
            : 'credits purchased (1,000 :free requests/day)';
        lines.push(
          `- account: ${free}${info.limit_remaining === undefined ? '' : ` · credit left: ${info.limit_remaining}`}`,
        );
      }
      lines.push('');
    }
    lines.push('Requests and tokens used today: `/usage`');
    ctx.panel('Status', lines.join('\n'));
  },
};

/** The ISO date `back` days before `date`. */
function daysBefore(date: string, back: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

/**
 * Recorded counts as per-model usage, so a stored day can be costed like a live session. Only
 * what providers reported is stored, so none of it is estimated.
 */
function recordedUsage(providers: ProviderUsage): Record<string, ModelUsage> {
  const out: Record<string, ModelUsage> = {};
  for (const [name, counts] of Object.entries(providers) as [
    ProviderName,
    ProviderUsage[ProviderName],
  ][]) {
    if (counts === undefined) continue;
    for (const [model, c] of Object.entries(counts.models)) {
      out[`${name}:${model}`] = {
        measured: { promptTokens: c.promptTokens, completionTokens: c.completionTokens },
        estimated: { promptTokens: 0, completionTokens: 0 },
      };
    }
  }
  return out;
}

/**
 * One "Last 7 days (3 days): 12 requests · 48K in · 9K out · $0.12" line. The day count says how
 * many of the window's days VinaX actually ran on, so it is left out for a single-day window.
 */
function rollupLine(
  label: string,
  rollup: UsageRollup,
  price: (ref: string) => Price | undefined,
  countDays = true,
): string {
  const total = usageTotals(rollup.providers);
  const days = countDays ? ` (${plural(rollup.dates.length, 'day')})` : '';
  if (total.requests === 0) return `- ${label}${days}: nothing recorded`;
  const cost = formatCost(costOf(recordedUsage(rollup.providers), price));
  return `- ${label}${days}: ${plural(total.requests, 'request')} · ${formatTokens(total.promptTokens)} in · ${formatTokens(total.completionTokens)} out · ${cost}`;
}

const usage: SlashCommand = {
  name: 'usage',
  description: 'Tokens and cost for this session, today, the last 7 days and all time',
  source: 'builtin',
  run(ctx) {
    const price = (ref: string) => priceFor(ref, ctx.runtime.settings.resolved, ctx.runtime.models);
    const session = ctx.sessionUsage();
    const lines: string[] = ['**This session**', ''];
    const refs = Object.keys(session);
    if (refs.length === 0) lines.push('No model calls yet.');
    for (const ref of refs) {
      const u = session[ref];
      if (!u) continue;
      const reported = totalTokens(u.measured);
      const estimated = totalTokens(u.estimated);
      const p = price(ref);
      const priced =
        reported + estimated === 0
          ? ''
          : p === undefined
            ? ' · price unknown'
            : ` · ${formatCost(costOf({ [ref]: u }, price))} (${p.source === 'settings' ? 'your settings' : 'the provider catalog'})`;
      lines.push(
        `- \`${ref}\`: ${formatTokens(u.measured.promptTokens)} in · ${formatTokens(u.measured.completionTokens)} out reported${estimated === 0 ? '' : ` · ~${formatTokens(estimated)} estimated`}${priced}`,
      );
    }
    if (refs.length > 0) lines.push('', `Cost: **${formatCost(costOf(session, price))}**`);

    const day = ctx.runtime.usage.snapshot();
    lines.push(
      '',
      '**Across every VinaX session** (reported tokens, priced at today’s rates):',
      '',
      rollupLine('Today', { dates: [day.date], providers: day.providers }, price, false),
      rollupLine('Last 7 days', ctx.runtime.usage.rollup(daysBefore(day.date, 6)), price),
      rollupLine('All time', ctx.runtime.usage.rollup(), price),
      '',
      `**Today** (${day.date}), provider by provider:`,
      '',
    );
    for (const name of PROVIDER_NAMES) {
      const p = day.providers[name];
      if (!p) continue;
      lines.push(
        `**${providerLabel(name)}** — ${plural(p.requests, 'request')} · ${formatTokens(p.promptTokens)} in · ${formatTokens(p.completionTokens)} out`,
      );
      for (const [m, c] of Object.entries(p.models)) {
        const ref = `${name}:${m}`;
        const cost =
          price(ref) === undefined
            ? ''
            : ` · ${formatCost(costOf(recordedUsage({ [name]: { ...c, models: { [m]: c } } }), price))}`;
        lines.push(
          `- \`${m}\`: ${plural(c.requests, 'request')} · ${formatTokens(c.promptTokens + c.completionTokens)} tokens${cost}`,
        );
      }
      if (name === 'openrouter') {
        const free = Object.entries(p.models)
          .filter(([m]) => m.endsWith(':free'))
          .reduce((n, [, c]) => n + c.requests, 0);
        lines.push(
          `- \`:free\` requests: **${String(free)}/50** of the free daily cap (1,000 with credits)`,
        );
      }
      lines.push('');
    }
    if (Object.keys(day.providers).length === 0) lines.push('No requests yet today.');
    lines.push(
      '',
      'Reported = counted by the provider. Estimated = VinaX counted ~4 characters per token where the provider sent no count (or the reply was cut off). Costs use only explicit prices: `pricing` in settings or the provider catalog — a model with no published price is left out and named. Rollups are priced at today’s rates, so a price that has since changed is not what you were charged then.',
    );
    ctx.panel('Usage', lines.join('\n'));
  },
};

const doctor: SlashCommand = {
  name: 'doctor',
  description: 'Check the installation, keys, search, shell and terminal',
  source: 'builtin',
  async run(ctx) {
    const checks = await ctx.busy('Running checks', () =>
      runDoctor({
        cwd: ctx.runtime.cwd,
        env: ctx.runtime.env,
        version: VERSION,
        runtime: ctx.runtime,
        terminal: { isTTY: process.stdout.isTTY, columns: process.stdout.columns },
      }),
    );
    if (!checks) return;
    ctx.panel(
      'Doctor',
      checks.map((c) => `${CHECK_ICON[c.status]} **${c.name}** — ${c.detail}`).join('\n\n'),
    );
  },
};

const health: SlashCommand = {
  name: 'health',
  description: 'Concise health summary: providers, keys, models, gateway, MCP, tools',
  source: 'builtin',
  async run(ctx) {
    const checks = await ctx.busy('Checking health', () =>
      runDoctor({
        cwd: ctx.runtime.cwd,
        env: ctx.runtime.env,
        version: VERSION,
        runtime: ctx.runtime,
        mcp: ctx.setup.mcp.servers,
        terminal: { isTTY: process.stdout.isTTY, columns: process.stdout.columns },
      }),
    );
    if (!checks) return;
    ctx.panel('Health', healthMarkdown(checks));
  },
};

const snake: SlashCommand = {
  name: 'snake',
  aliases: ['game'],
  description: 'Play Snake II, Nokia-style: levels, mazes and top scores, in colour',
  source: 'builtin',
  async run(ctx) {
    const store = new AppStateStore(ctx.runtime.env);
    const saved = await store.read();
    const prefs = prefsFromState(saved);
    const before = Math.max(saved.snakeBest, topScore(prefs));
    // saves are queued so a quick burst of changes cannot interleave its writes
    let saving: Promise<unknown> = Promise.resolve();
    const session: SnakeSession = {
      prefs,
      last: undefined,
      save: (p) => {
        saving = saving
          .then(() => store.update((s) => ({ ...s, ...stateFromPrefs(p) })))
          .catch(() => undefined);
      },
    };
    snakeSession.current = session;
    let score: number;
    try {
      score = await ctx.playSnake(before);
    } finally {
      snakeSession.current = undefined;
    }
    await saving;
    const last = session.last;
    const best = Math.max(before, score);
    ctx.notice(
      'info',
      last === undefined
        ? `Snake: ${String(score)} points (best ${String(best)}).`
        : `Snake: ${String(last.score)} points (level ${String(last.level)}, ${MAZE_LABELS[last.maze]})${last.newTop && last.score > 0 ? ' — new top score!' : ''} · best ${String(best)}.`,
    );
  },
};

const update: SlashCommand = {
  name: 'update',
  description: 'Check for a newer VinaX and show how to update',
  source: 'builtin',
  async run(ctx) {
    const release = await ctx.busy('Checking for updates', () => latestRelease(ctx.runtime.env));
    if (!release) return;
    const install = detectInstall();
    const newer = compareVersions(release.version, VERSION) > 0;
    const how =
      install.kind === 'npm'
        ? '`vinax update` (runs `npm install -g @sirimillavinay/vinax@latest`)'
        : install.kind === 'binary'
          ? '`vinax update` (downloads the new binary and checks its SHA-256)'
          : '`git pull && pnpm install && pnpm build` in your VinaX checkout';
    ctx.panel(
      'Updates',
      [
        `- Installed: **v${VERSION}** · ${installLabel()}`,
        `- Latest: **v${release.version}** ${newer ? '— an update is available' : '— you are up to date ✔'}`,
        '',
        ...(newer ? [`Update with ${how}, then restart VinaX.`, ''] : []),
        `Release notes: ${releaseUrl(release.version)} · \`/changelog\` shows recent changes.`,
      ].join('\n'),
    );
  },
};

const changelog: SlashCommand = {
  name: 'changelog',
  aliases: ['whats-new'],
  description: "What's new in recent VinaX releases",
  source: 'builtin',
  async run(ctx) {
    const text = await readChangelog();
    const notes = text === undefined ? [] : releaseNotes(text, undefined, VERSION, 14);
    ctx.panel(
      `What's new in VinaX v${VERSION}`,
      notes.length === 0
        ? `Release notes: ${releaseUrl(VERSION)}`
        : `${notesMarkdown(notes)}\n\nAll releases: ${PROJECT_URL}/releases`,
    );
  },
};

function installLabel(): string {
  const install = detectInstall();
  switch (install.kind) {
    case 'binary':
      return `standalone binary (${install.target})`;
    case 'npm':
      return 'npm package (@sirimillavinay/vinax)';
    case 'source':
      return 'from source';
  }
}

const about: SlashCommand = {
  name: 'about',
  description: 'Version, runtime, install, model, gateway and MCP at a glance',
  source: 'builtin',
  run(ctx) {
    const { runtime } = ctx;
    const current = ctx.setup.agent.model ?? runtime.settings.resolved.model;
    const ref = parseModelRef(current);
    const alias = modelAlias(current);
    const bun = (process.versions as Record<string, string | undefined>).bun;
    const servers = ctx.setup.mcp.servers;
    const connected = servers.filter((s) => s.status === 'connected').length;
    const gateway = runtime.gateway
      ? `${runtime.gateway.url}${runtime.viaGateway.size === 0 ? ' (not in use: own keys)' : ` · serving ${[...runtime.viaGateway].map(providerLabel).join(', ')}`}`
      : 'not used';
    const rows: [string, string][] = [
      ['Version', `v${VERSION}`],
      ['Runtime', bun === undefined ? `Node.js ${process.version}` : `Bun ${bun}`],
      ['Installation', installLabel()],
      ['Provider', `${providerLabel(ref.provider)} (${providerHost(ref.provider)})`],
      ['Model', `\`${ref.model}\`${alias === undefined ? '' : ` · \`${alias}\``}`],
      ['Gateway', gateway],
      [
        'MCP',
        servers.length === 0
          ? 'no servers'
          : `${String(connected)}/${String(servers.length)} servers connected`,
      ],
      ['Platform', `${os.type()} ${os.release()}`],
      ['Architecture', process.arch],
      ['Repository', PROJECT_URL],
    ];
    ctx.panel(
      'About VinaX',
      [
        '**VinaX** — your AI coding agent for the terminal',
        '',
        '| | |',
        '|---|---|',
        ...rows.map(([k, v]) => `| ${k} | ${v} |`),
      ].join('\n'),
    );
  },
};

async function chooseProvider(
  ctx: CommandContext,
  title: string,
): Promise<ProviderName | undefined> {
  return ctx.pick<ProviderName>(title, [
    ...PROVIDER_NAMES.map((p) => ({
      label: providerLabel(p),
      value: p,
      hint: ctx.runtime.providers.has(p) && !ctx.runtime.viaGateway.has(p) ? '(configured)' : '',
    })),
  ]);
}

const login: SlashCommand = {
  name: 'login',
  description: 'Add a provider API key',
  source: 'builtin',
  async run(ctx) {
    const provider = await chooseProvider(ctx, 'Add a key for which provider?');
    if (provider === undefined) return;
    // Open the page that issues the key before asking for it, so there is something to paste.
    const page = providerKeyPage(provider);
    openInBrowser(page);
    ctx.notice('info', `Opening ${page} to get a ${providerLabel(provider)} key.`);
    const key = await ctx.ask(
      `${providerLabel(provider)} API key`,
      `Paste the key from ${page} and press Enter`,
      { mask: true },
    );
    if (key === undefined || key === '') return;
    const check = await ctx.busy(`Checking the key with ${providerLabel(provider)}`, (signal) =>
      createProvider(provider, key, {
        settings: ctx.runtime.settings.resolved,
        ledger: new RateLimitLedger(() => Number.POSITIVE_INFINITY),
        logger: noopLogger,
      }).validateKey(signal),
    );
    if (!check) return;
    if (!check.ok && check.rejected) {
      ctx.notice('error', `${providerLabel(provider)} rejected that key; it was not saved.`);
      return;
    }
    const where = await (await openSecretStore(ctx.runtime.env)).set(provider, key);
    ctx.runtime.setProviderKey(provider, key);
    // the old list may have come from a gateway that did not serve this provider
    await ctx.busy(`Loading ${providerLabel(provider)} models`, (signal) =>
      ctx.runtime.refreshCatalog(provider, signal),
    );
    ctx.notice(
      check.ok ? 'info' : 'warning',
      `Saved the ${providerLabel(provider)} key to the ${where === 'keychain' ? 'OS keychain' : 'credentials file'}${check.ok ? '' : ` (could not verify it: ${check.reason})`}.`,
    );
  },
};

const logout: SlashCommand = {
  name: 'logout',
  description: 'Remove a stored provider API key',
  source: 'builtin',
  async run(ctx) {
    const provider = await chooseProvider(ctx, 'Remove the key for which provider?');
    if (provider === undefined) return;
    const removed = await (await openSecretStore(ctx.runtime.env)).delete(provider);
    const envVar = SECRET_ENV_VARS[provider];
    if (ctx.runtime.env[envVar] !== undefined) {
      ctx.notice(
        'warning',
        `${removed ? 'Removed the stored key, but ' : ''}${envVar} is set in your environment and is still used.`,
      );
      return;
    }
    ctx.runtime.removeProvider(provider);
    ctx.notice(
      'info',
      removed
        ? `Removed the ${providerLabel(provider)} key.`
        : `No stored ${providerLabel(provider)} key.`,
    );
  },
};

const theme: SlashCommand = {
  name: 'theme',
  description: 'Change the colour theme',
  source: 'builtin',
  async run(ctx) {
    const name = await ctx.pick(
      'Colour theme',
      THEME_NAMES.map((t) => ({ label: THEME_LABELS[t], value: t })),
    );
    if (name === undefined) return;
    ctx.setTheme(name);
    await saveUserSetting(ctx, 'theme', name);
    ctx.notice('info', `Theme set to ${THEME_LABELS[name]}.`);
  },
};

const vim: SlashCommand = {
  name: 'vim',
  description: 'Toggle vim key bindings in the prompt',
  source: 'builtin',
  async run(ctx) {
    const next = ctx.editorMode() === 'vim' ? 'normal' : 'vim';
    ctx.setEditorMode(next);
    await saveUserSetting(ctx, 'editorMode', next);
    ctx.notice(
      'info',
      next === 'vim' ? 'Vim mode on: Esc for NORMAL, i/a/o for INSERT.' : 'Vim mode off.',
    );
  },
};

const exportCmd: SlashCommand = {
  name: 'export',
  argumentHint: '[file]',
  description: 'Save the conversation as Markdown',
  source: 'builtin',
  async run(ctx) {
    const file = path.resolve(
      ctx.runtime.cwd,
      ctx.args === '' ? `vinax-${ctx.session.id}.md` : ctx.args,
    );
    const title = ctx.sessionTitle();
    await fs.writeFile(
      file,
      conversationMarkdown(ctx.setup.agent.messages, {
        ...(title === undefined ? {} : { title }),
        cwd: ctx.runtime.cwd,
        date: new Date(),
      }),
      'utf8',
    );
    ctx.notice('info', `Saved the conversation to ${shortenPath(file)}.`);
  },
};

const bug: SlashCommand = {
  name: 'bug',
  argumentHint: '[what went wrong]',
  description: 'Open a pre-filled GitHub issue',
  source: 'builtin',
  run(ctx) {
    const body = [
      '**What happened**',
      ctx.args === '' ? '<describe the problem>' : ctx.args,
      '',
      '**Environment**',
      `- VinaX ${VERSION}`,
      `- ${os.type()} ${os.release()} (${process.platform}/${process.arch}), Node ${process.version}`,
      `- model: ${formatModelRef(parseModelRef(ctx.setup.agent.model ?? ctx.runtime.settings.resolved.model))}`,
      `- terminal: ${ctx.runtime.env.TERM_PROGRAM ?? ctx.runtime.env.TERM ?? 'unknown'}`,
    ].join('\n');
    const url = `${PROJECT_URL}/issues/new?${new URLSearchParams({ title: ctx.args.slice(0, 80) || 'Bug: ', body }).toString()}`;
    openInBrowser(url);
    ctx.panel(
      'Report a bug',
      `Opening your browser. If nothing happens, open this link:\n\n${url}`,
    );
  },
};

const hooks: SlashCommand = {
  name: 'hooks',
  description: 'Show configured hooks',
  source: 'builtin',
  run(ctx) {
    const configured = ctx.setup.hooks.configured;
    const lines: string[] = [];
    if (ctx.runtime.settings.resolved.disableAllHooks)
      lines.push('**All hooks are disabled** (`disableAllHooks: true`).', '');
    for (const event of HOOK_EVENTS) {
      const groups = configured[event] ?? [];
      if (groups.length === 0) continue;
      lines.push(`**${event}**`);
      for (const g of groups) {
        for (const h of g.hooks) {
          lines.push(
            `- ${g.matcher === undefined || g.matcher === '' ? '' : `\`${g.matcher}\` → `}\`${h.command}\`${h.timeout === undefined ? '' : ` (timeout ${String(h.timeout)}s)`}`,
          );
        }
      }
      lines.push('');
    }
    if (lines.length === 0) lines.push('No hooks configured.', '');
    lines.push(
      'Hooks are shell commands in the `hooks` section of settings. They get the event as JSON on stdin. Exit 0 continues, and exit 2 blocks the action and sends stderr to VinaX. Events: ' +
        HOOK_EVENTS.map((e) => `\`${e}\``).join(', ') +
        '.',
    );
    ctx.panel('Hooks', lines.join('\n'));
  },
};

const STATUS_ICON = {
  connected: '✔',
  failed: '✖',
  'needs-approval': '⏸',
  connecting: '…',
} as const;

const mcp: SlashCommand = {
  name: 'mcp',
  description: 'MCP servers, their tools, and approving project servers',
  source: 'builtin',
  async run(ctx) {
    const servers = ctx.setup.mcp.servers;
    if (servers.length === 0) {
      ctx.panel(
        'MCP servers',
        'No MCP servers configured. Add one with `vinax mcp add <name> <command or url>`, or edit `.vinax/mcp.json` or `~/.vinax/mcp.json`.',
      );
      return;
    }
    const lines = servers.map((s) => {
      const head = `${STATUS_ICON[s.status]} **${s.name}** _(${s.scope})_ — ${s.status === 'connected' ? plural(s.tools.length, 'tool') : s.status === 'failed' ? `failed: ${s.error ?? ''}` : s.status === 'needs-approval' ? 'waiting for your approval' : 'connecting'}`;
      const tools = s.tools.map((t) => `  - \`${t.name}\``).join('\n');
      return tools === '' ? head : `${head}\n${tools}`;
    });
    ctx.panel(
      'MCP servers',
      `${lines.join('\n\n')}\n\nMCP tools ask before running; allow them with rules like \`mcp__server__*\`.`,
    );
    const waiting = servers.filter((s) => s.status === 'needs-approval' || s.status === 'failed');
    if (waiting.length === 0) return;
    const name = await ctx.pick(
      'Start a project MCP server? It runs a program or connects to a URL configured in this repository.',
      [
        ...waiting.map((s) => ({
          label: `${s.status === 'failed' ? 'Retry' : 'Allow and start'} ${s.name}`,
          value: s.name,
          hint:
            'command' in s.config
              ? `${s.config.command} ${(s.config.args ?? []).join(' ')}`
              : s.config.url,
        })),
        { label: 'Not now', value: '' },
      ],
    );
    if (name === undefined || name === '') return;
    const result = await ctx.busy(`Starting ${name}`, async () => {
      await ctx.setup.approveMcpServer(name);
      return ctx.setup.mcp.servers.find((s) => s.name === name);
    });
    if (result?.status === 'connected')
      ctx.notice('info', `Started ${name} with ${plural(result.tools.length, 'tool')}.`);
  },
};

const agents: SlashCommand = {
  name: 'agents',
  description: 'Sub-agents the Task tool can use',
  source: 'builtin',
  run(ctx) {
    const lines = ctx.setup.subagents.map(
      (a) =>
        `**${a.name}** _(${a.source})_ — ${a.description}\n  tools: ${a.tools === undefined ? 'all' : a.tools.join(', ')}${a.model === undefined ? '' : ` · model: \`${a.model}\``}`,
    );
    ctx.panel(
      'Sub-agents',
      `${lines.join('\n\n')}\n\nAdd your own as Markdown files in \`.vinax/agents/\` or \`~/.vinax/agents/\`. The frontmatter holds \`name\`, \`description\`, optional \`tools\` and \`model\`; the body is the agent's instructions.`,
    );
  },
};

const exit: SlashCommand = {
  name: 'exit',
  aliases: ['quit'],
  description: 'Quit VinaX',
  source: 'builtin',
  run: (ctx) => {
    ctx.exit();
  },
};

export const BUILTIN_COMMANDS: readonly SlashCommand[] = [
  help,
  clear,
  compact,
  model,
  models,
  settingsCommand(showEffectiveSettings, openPermissions, async (ctx) => {
    const ref = await pickModel(ctx, 'Model for this session');
    if (ref !== undefined) switchModel(ctx, ref);
  }),
  effort,
  outputStyle,
  plugin,
  permissionsCommand,
  copy,
  skills,
  init,
  memory,
  resume,
  rewind,
  changes,
  status,
  contextCommand,
  usage,
  doctor,
  health,
  about,
  update,
  changelog,
  snake,
  login,
  logout,
  theme,
  vim,
  hooks,
  mcp,
  agents,
  exportCmd,
  bug,
  exit,
];
