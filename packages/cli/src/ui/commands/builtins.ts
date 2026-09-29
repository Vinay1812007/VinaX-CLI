import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  conversationMarkdown,
  createProvider,
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
  providerLabel,
  RateLimitLedger,
  runDoctor,
  SECRET_ENV_VARS,
  settingsPaths,
  THEME_NAMES,
  updateSettingsFile,
  checkGateway,
  gatewayUrlProblem,
  removeGatewayLogin,
  saveGatewayLogin,
  type ProviderName,
} from '@vinax/core';
import { CHECK_ICON, healthMarkdown } from '../../health.js';
import { detectInstall } from '../../update.js';
import { VERSION } from '../../version.js';
import { gatewayLacks, modelSelectItems, providerSummaries } from '../model-items.js';
import { sessionItems } from '../sessions.js';
import { formatTokens, shortenPath } from '../format.js';
import { THEME_LABELS } from '../theme.js';
import { sessionStore } from '../../session.js';
import type { CommandContext, SlashCommand } from './types.js';

const INIT_PROMPT = `Study this codebase and write a VINAX.md file in the project root that will help future VinaX sessions work here. Cover:
1. How to build, test, lint and run it — exact commands, including how to run a single test.
2. A short architecture overview: the big picture that takes reading several files to understand.
3. Conventions that are not obvious from the code (naming, error handling, where things go).
Keep it under 60 lines, factual and specific to this project — no generic advice. If VINAX.md already exists, improve it instead of starting over. Fold in anything useful from README.md, AGENTS.md or other assistant rule files.`;

function plural(n: number, word: string): string {
  return `${String(n)} ${word}${n === 1 ? '' : 's'}`;
}

function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url]]
        : ['xdg-open', [url]];
  execFile(cmd, args, () => undefined);
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
        'Press `?` on an empty prompt for keyboard shortcuts. Custom commands live in `.vinax/commands/*.md` and `~/.vinax/commands/*.md`.',
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
  const items = modelSelectItems(ctx.runtime, current);
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
  argumentHint: '[provider:model | alias]',
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
    lines.push('', '**Aliases**');
    for (const k of KNOWN_MODELS)
      if (k.alias !== undefined)
        lines.push(`- \`${k.alias}\` → \`${k.provider}:${k.model}\` · ${k.label}`);
    lines.push(
      '',
      'Change the default with `vinax config set model <ref|alias>` and the order with `fallbackChain` in settings.',
    );
    ctx.panel('Models', lines.join('\n'));
    const ref = await pickModel(ctx, 'Switch model? (Esc keeps the current one)');
    if (ref !== undefined && ref !== current) switchModel(ctx, ref);
  },
};

const config: SlashCommand = {
  name: 'config',
  description: 'Show the effective settings and where they come from',
  source: 'builtin',
  run(ctx) {
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
        'Change settings with `vinax config set <key> <value>` (see `vinax config --help`).',
      ].join('\n'),
    );
  },
};

const permissions: SlashCommand = {
  name: 'permissions',
  description: 'Show permission mode and rules',
  source: 'builtin',
  run(ctx) {
    const rules = ctx.setup.permissions.listRules();
    const section = (effect: 'allow' | 'ask' | 'deny') => {
      const list = rules.filter((r) => r.effect === effect);
      return list.length === 0
        ? [`**${effect}:** none`]
        : [`**${effect}:**`, ...list.map((r) => `- \`${r.raw}\` _(${r.source})_`)];
    };
    ctx.panel(
      'Permissions',
      [
        `Mode: **${ctx.mode()}** (Shift+Tab to change)`,
        `Folders tools may use: ${ctx.setup.workspace.map((w) => `\`${shortenPath(w)}\``).join(', ')}`,
        '',
        ...section('deny'),
        '',
        ...section('ask'),
        '',
        ...section('allow'),
        '',
        'Add rules under `permissions` in `.vinax/settings.json`, or answer "don\'t ask again" in an approval prompt.',
      ].join('\n'),
    );
  },
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

const usage: SlashCommand = {
  name: 'usage',
  description: 'Requests and tokens used today, per provider',
  source: 'builtin',
  run(ctx) {
    const day = ctx.runtime.usage.snapshot();
    const lines = [`Today (${day.date}, all VinaX sessions):`, ''];
    for (const name of PROVIDER_NAMES) {
      const p = day.providers[name];
      if (!p) continue;
      lines.push(
        `**${providerLabel(name)}** — ${plural(p.requests, 'request')} · ${formatTokens(p.promptTokens)} in · ${formatTokens(p.completionTokens)} out`,
      );
      for (const [m, c] of Object.entries(p.models)) {
        lines.push(
          `- \`${m}\`: ${plural(c.requests, 'request')} · ${formatTokens(c.promptTokens + c.completionTokens)} tokens`,
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
    if (lines.length === 2) lines.push('No requests yet today.');
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
): Promise<ProviderName | 'gateway' | undefined> {
  return ctx.pick<ProviderName | 'gateway'>(title, [
    ...PROVIDER_NAMES.map((p) => ({
      label: providerLabel(p),
      value: p,
      hint: ctx.runtime.providers.has(p) && !ctx.runtime.viaGateway.has(p) ? '(configured)' : '',
    })),
    {
      label: 'VinaX gateway',
      value: 'gateway' as const,
      hint: ctx.runtime.gateway
        ? `(${ctx.runtime.gateway.url})`
        : 'a shared server someone runs for you',
    },
  ]);
}

async function loginGateway(ctx: CommandContext): Promise<void> {
  const url = (
    await ctx.ask(
      'VinaX gateway URL',
      ctx.runtime.gateway?.url ?? 'https://your-gateway.onrender.com',
    )
  )?.replace(/\/+$/, '');
  if (url === undefined || url === '') return;
  const problem = gatewayUrlProblem(url);
  if (problem !== undefined) {
    ctx.notice('error', `✖ ${problem}`);
    return;
  }
  const token = await ctx.ask('VinaX gateway token', 'Paste the token and press Enter', {
    mask: true,
  });
  if (token === undefined || token === '') return;
  const check = await ctx.busy(
    'Checking the gateway (a sleeping one takes up to a minute to wake)',
    (signal) =>
      checkGateway(url, token, {
        timeoutMs: ctx.runtime.settings.resolved.gateway.timeoutMs,
        signal,
      }),
  );
  if (!check) return;
  if (!check.ok && check.rejected) {
    ctx.notice('error', `✖ ${check.reason}; nothing was saved.`);
    return;
  }
  await saveGatewayLogin(url, token, { cwd: ctx.runtime.cwd, env: ctx.runtime.env });
  ctx.runtime.setGateway(url, token);
  const via = [...ctx.runtime.viaGateway].map(providerLabel);
  ctx.notice(
    check.ok ? 'info' : 'warning',
    `${check.ok ? 'Connected to' : 'Saved'} the VinaX gateway at ${url}${check.ok ? '' : ` (could not verify it: ${check.reason})`}. ${via.length === 0 ? 'Your own keys are used for every provider.' : `${via.join(' and ')} now go${via.length === 1 ? 'es' : ''} through it.`}`,
  );
}

const login: SlashCommand = {
  name: 'login',
  description: 'Add a provider API key, or connect to a VinaX gateway',
  source: 'builtin',
  async run(ctx) {
    const provider = await chooseProvider(ctx, 'Add a key for which provider?');
    if (provider === undefined) return;
    if (provider === 'gateway') {
      await loginGateway(ctx);
      return;
    }
    const key = await ctx.ask(
      `${providerLabel(provider)} API key`,
      'Paste the key and press Enter',
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
    ctx.notice(
      check.ok ? 'info' : 'warning',
      `Saved the ${providerLabel(provider)} key to the ${where === 'keychain' ? 'OS keychain' : 'credentials file'}${check.ok ? '' : ` (could not verify it: ${check.reason})`}.`,
    );
  },
};

const logout: SlashCommand = {
  name: 'logout',
  description: 'Remove a stored provider API key, or disconnect the gateway',
  source: 'builtin',
  async run(ctx) {
    const provider = await chooseProvider(ctx, 'Remove the key for which provider?');
    if (provider === undefined) return;
    if (provider === 'gateway') {
      const removed = await removeGatewayLogin({ cwd: ctx.runtime.cwd, env: ctx.runtime.env });
      ctx.runtime.removeProvider('gateway');
      ctx.notice(
        'info',
        removed ? 'Disconnected from the VinaX gateway.' : 'No gateway was configured.',
      );
      return;
    }
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
  config,
  permissions,
  init,
  memory,
  resume,
  rewind,
  status,
  usage,
  doctor,
  health,
  about,
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
