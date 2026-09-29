import {
  parseRule,
  REASONING_EFFORTS,
  THEME_NAMES,
  updateSettingsFile,
  type PermissionMode,
  type ReasoningEffort,
  type ThemeName,
  type WritableScope,
} from '@vinax/core';
import { codeBlocks, copyToClipboard } from '../../clipboard.js';
import type { SettingRow } from '../components/SettingsPanel.js';
import { MODE_CYCLE, MODE_DESCRIPTIONS, MODE_LABELS } from '../components/StatusLine.js';
import { shortenPath } from '../format.js';
import type { CommandContext, SlashCommand } from './types.js';

type Effort = ReasoningEffort | 'auto';
const EFFORTS: readonly Effort[] = ['auto', ...REASONING_EFFORTS];

/** A little meter for each effort level. */
export const EFFORT_BARS: Record<Effort, string> = {
  auto: '▱▱▱',
  low: '▰▱▱',
  medium: '▰▰▱',
  high: '▰▰▰',
};

const EFFORT_HINTS: Record<Effort, string> = {
  auto: "the model's own default",
  low: 'fastest answers, least thinking',
  medium: 'balanced',
  high: 'most thorough reasoning, slower',
};

/** Writes (or with `undefined`, removes) one top-level user setting. */
async function saveUserSetting(ctx: CommandContext, key: string, value: unknown): Promise<void> {
  await updateSettingsFile({ cwd: ctx.runtime.cwd, env: ctx.runtime.env, scope: 'user' }, (s) => {
    const next = { ...s };
    if (value === undefined) Reflect.deleteProperty(next, key);
    else next[key] = value;
    return next;
  });
}

async function setEffort(ctx: CommandContext, effort: Effort): Promise<void> {
  ctx.setup.agent.setEffort(effort === 'auto' ? undefined : effort);
  await saveUserSetting(ctx, 'reasoningEffort', effort === 'auto' ? undefined : effort);
}

export const effort: SlashCommand = {
  name: 'effort',
  argumentHint: '[auto|low|medium|high]',
  description: 'How hard the model thinks before answering (reasoning effort)',
  source: 'builtin',
  async run(ctx) {
    const current: Effort = ctx.setup.agent.effort ?? 'auto';
    let chosen: Effort | undefined;
    if (ctx.args !== '') {
      const arg = ctx.args.toLowerCase();
      if (!(EFFORTS as readonly string[]).includes(arg)) {
        ctx.notice('error', `Unknown effort "${ctx.args}". Use auto, low, medium or high.`);
        return;
      }
      chosen = arg as Effort;
    } else {
      chosen = await ctx.pick(
        'Reasoning effort',
        EFFORTS.map((e) => ({
          label: `${EFFORT_BARS[e]}  ${e}${e === current ? '  (current)' : ''}`,
          value: e,
          hint: EFFORT_HINTS[e],
        })),
      );
    }
    if (chosen === undefined) return;
    await setEffort(ctx, chosen);
    ctx.notice(
      'info',
      chosen === 'auto'
        ? 'Effort set to auto: the model decides how long to think.'
        : `Effort set to ${chosen} ${EFFORT_BARS[chosen]}. Models that support it (gpt-oss) will think ${chosen === 'high' ? 'longer' : chosen === 'low' ? 'less' : 'moderately'} before answering; others ignore it.`,
    );
  },
};

const onOff = (b: boolean): string => (b ? 'on' : 'off');

function settingsRows(ctx: CommandContext): SettingRow[] {
  const r = ctx.runtime.settings.resolved;
  return [
    { key: 'model', label: 'Model', value: ctx.setup.agent.model ?? r.model, action: true },
    {
      key: 'effort',
      label: 'Reasoning effort',
      value: ctx.setup.agent.effort ?? 'auto',
      options: EFFORTS,
    },
    {
      key: 'mode',
      label: 'Default permission mode',
      value: r.permissions.defaultMode,
      options: MODE_CYCLE,
      labels: { default: 'manual', acceptEdits: 'accept edits', plan: 'plan', auto: 'auto' },
      hint: 'also switches this session',
    },
    {
      key: 'theme',
      label: 'Theme',
      value: ctx.runtime.settings.resolved.theme,
      options: THEME_NAMES,
      labels: { dark: 'dark', light: 'light', colorblind: 'colour-blind friendly' },
    },
    {
      key: 'editorMode',
      label: 'Editor mode',
      value: ctx.editorMode(),
      options: ['normal', 'vim'],
    },
    {
      key: 'autoCompact',
      label: 'Auto-compact',
      value: onOff(r.context.autoCompact),
      options: ['on', 'off'],
      hint: 'applies to new sessions',
    },
    {
      key: 'updateCheck',
      label: 'Update notifications',
      value: onOff(r.updateCheck),
      options: ['on', 'off'],
    },
    { key: 'showTips', label: 'Welcome tips', value: onOff(r.showTips), options: ['on', 'off'] },
    { key: 'permissions', label: 'Permission rules', value: 'edit', action: true },
    { key: 'json', label: 'Effective settings', value: 'show JSON', action: true },
  ];
}

/** Keeps the in-memory settings in step with what was saved, so the panel shows it. */
function remember(
  ctx: CommandContext,
  patch: (r: CommandContext['runtime']['settings']['resolved']) => void,
): void {
  patch(ctx.runtime.settings.resolved);
}

export function settingsCommand(
  showJson: (ctx: CommandContext) => void,
  openPermissions: (ctx: CommandContext) => Promise<void>,
  pickModel: (ctx: CommandContext) => Promise<void>,
): SlashCommand {
  return {
    name: 'settings',
    aliases: ['config'],
    description: 'Change settings: model, effort, permission mode, theme, editor and more',
    source: 'builtin',
    async run(ctx) {
      const action = await ctx.editSettings('Settings', settingsRows(ctx), async (key, value) => {
        switch (key) {
          case 'effort':
            await setEffort(ctx, value as Effort);
            break;
          case 'mode':
            await saveUserSetting(ctx, 'permissions', {
              ...currentPermissions(ctx),
              defaultMode: value,
            });
            remember(ctx, (r) => {
              r.permissions.defaultMode = value as PermissionMode;
            });
            ctx.setMode(value as PermissionMode);
            break;
          case 'theme':
            ctx.setTheme(value as ThemeName);
            await saveUserSetting(ctx, 'theme', value);
            remember(ctx, (r) => {
              r.theme = value as ThemeName;
            });
            break;
          case 'editorMode':
            ctx.setEditorMode(value as 'normal' | 'vim');
            await saveUserSetting(ctx, 'editorMode', value);
            break;
          case 'autoCompact':
            await saveUserSetting(ctx, 'context', {
              ...ctx.runtime.settings.merged.context,
              autoCompact: value === 'on',
            });
            remember(ctx, (r) => {
              r.context.autoCompact = value === 'on';
            });
            break;
          case 'updateCheck':
          case 'showTips':
            await saveUserSetting(ctx, key, value === 'on');
            remember(ctx, (r) => {
              r[key] = value === 'on';
            });
            break;
        }
        return undefined;
      });
      if (action === 'model') await pickModel(ctx);
      else if (action === 'permissions') await openPermissions(ctx);
      else if (action === 'json') showJson(ctx);
    },
  };
}

function currentPermissions(ctx: CommandContext): Record<string, unknown> {
  const user = ctx.runtime.settings.layers.find((l) => l.source === 'user');
  return { ...(user?.settings.permissions ?? {}) };
}

const SCOPE_LABELS: Record<WritableScope, string> = {
  local: 'This project, only for me (.vinax/settings.local.json)',
  project: 'This project, shared (.vinax/settings.json)',
  user: 'All my projects (~/.vinax/settings.json)',
};

type RuleEffect = 'allow' | 'ask' | 'deny';

async function addRule(ctx: CommandContext, effect: RuleEffect): Promise<void> {
  const raw = await ctx.ask(
    `New ${effect} rule`,
    effect === 'deny'
      ? 'e.g. Bash(git push:*) or Read(./.env)'
      : 'e.g. Bash(npm test:*), Edit(src/**) or WebFetch',
  );
  if (raw === undefined || raw.trim() === '') return;
  if (!parseRule(raw, effect, 'new')) {
    ctx.notice(
      'error',
      `"${raw}" is not a valid rule. Examples: Bash(npm test:*), Edit(src/**), mcp__server__*`,
    );
    return;
  }
  const scope = await ctx.pick(
    'Save the rule where?',
    (['local', 'project', 'user'] as const).map((s) => ({ label: SCOPE_LABELS[s], value: s })),
  );
  if (scope === undefined) return;
  const file = await updateSettingsFile(
    { cwd: ctx.runtime.cwd, env: ctx.runtime.env, scope },
    (s) => {
      const perms = (s.permissions ?? {}) as Record<string, unknown>;
      const list = Array.isArray(perms[effect]) ? (perms[effect] as string[]) : [];
      return { ...s, permissions: { ...perms, [effect]: [...new Set([...list, raw.trim()])] } };
    },
  );
  ctx.setup.permissions.addSessionRule(raw.trim(), effect);
  ctx.notice('info', `Added ${effect} rule ${raw.trim()} to ${shortenPath(file)}.`);
}

async function removeRule(ctx: CommandContext): Promise<void> {
  const rules = ctx.setup.permissions.listRules().filter((r) => r.source !== 'command');
  if (rules.length === 0) {
    ctx.notice('info', 'There are no rules to remove.');
    return;
  }
  const pick = await ctx.pick(
    'Remove which rule?',
    rules.map((r) => ({ label: `${r.effect.padEnd(5)} ${r.raw}`, value: r, hint: r.source })),
    { searchable: true },
  );
  if (pick === undefined) return;
  ctx.setup.permissions.removeRule(pick.raw, pick.effect);
  for (const scope of ['user', 'project', 'local'] as const) {
    await updateSettingsFile({ cwd: ctx.runtime.cwd, env: ctx.runtime.env, scope }, (s) => {
      const perms = s.permissions as Record<string, unknown> | undefined;
      const list = perms?.[pick.effect];
      if (!Array.isArray(list) || !list.includes(pick.raw)) return s;
      return {
        ...s,
        permissions: { ...perms, [pick.effect]: list.filter((x) => x !== pick.raw) },
      };
    }).catch(() => undefined);
  }
  ctx.notice('info', `Removed the ${pick.effect} rule ${pick.raw}.`);
}

/** Claude Code-style /permissions: the rules by kind, then add, remove or change the mode. */
export async function openPermissions(ctx: CommandContext): Promise<void> {
  const rules = ctx.setup.permissions.listRules();
  const section = (effect: RuleEffect, title: string) => {
    const list = rules.filter((r) => r.effect === effect);
    return list.length === 0
      ? [`**${title}** — none`]
      : [`**${title}**`, ...list.map((r) => `- \`${r.raw}\` _(${r.source})_`)];
  };
  ctx.panel(
    'Permissions',
    [
      `Mode: **${MODE_LABELS[ctx.mode()]}** — ${MODE_DESCRIPTIONS[ctx.mode()]}`,
      `Folders tools may use: ${ctx.setup.workspace.map((w) => `\`${shortenPath(w)}\``).join(', ')}`,
      '',
      ...section('allow', 'Allow'),
      '',
      ...section('ask', 'Ask'),
      '',
      ...section('deny', 'Deny'),
      '',
      'Deny rules always win, and dangerous commands always ask, whatever the mode.',
    ].join('\n'),
  );
  const choice = await ctx.pick('What would you like to do?', [
    { label: 'Add an allow rule', value: 'allow', hint: 'run without asking' },
    { label: 'Add an ask rule', value: 'ask', hint: 'always ask first' },
    { label: 'Add a deny rule', value: 'deny', hint: 'never allow' },
    { label: 'Remove a rule', value: 'remove' },
    { label: 'Change the permission mode', value: 'mode' },
    { label: 'Done', value: 'done' },
  ]);
  if (choice === 'allow' || choice === 'ask' || choice === 'deny') await addRule(ctx, choice);
  else if (choice === 'remove') await removeRule(ctx);
  else if (choice === 'mode') {
    const mode = await ctx.pick(
      'Permission mode for this session',
      MODE_CYCLE.map((m) => ({
        label: `${MODE_LABELS[m]}${m === ctx.mode() ? '  (current)' : ''}`,
        value: m,
        hint: MODE_DESCRIPTIONS[m],
      })),
    );
    if (mode !== undefined) {
      ctx.setMode(mode);
      ctx.notice('info', `${MODE_LABELS[mode]} — ${MODE_DESCRIPTIONS[mode]}.`);
    }
  }
}

export const permissionsCommand: SlashCommand = {
  name: 'permissions',
  aliases: ['allowed-tools'],
  description: 'Permission mode and rules: view, add, remove',
  source: 'builtin',
  run: (ctx) => openPermissions(ctx),
};

export const copy: SlashCommand = {
  name: 'copy',
  argumentHint: '[n]',
  description: "Copy VinaX's last answer (or its nth code block) to the clipboard",
  source: 'builtin',
  async run(ctx) {
    const last = [...ctx.setup.agent.messages]
      .reverse()
      .find((m) => m.role === 'assistant' && m.content.trim() !== '');
    if (!last) {
      ctx.notice('info', 'Nothing to copy yet.');
      return;
    }
    let text = last.content.trim();
    let what = 'the last answer';
    if (ctx.args !== '') {
      const n = Number(ctx.args);
      const blocks = codeBlocks(text);
      const block = Number.isInteger(n) && n >= 1 ? blocks[n - 1] : undefined;
      if (!block) {
        ctx.notice(
          'error',
          blocks.length === 0
            ? 'The last answer has no code blocks.'
            : `Pick a code block from 1 to ${String(blocks.length)}.`,
        );
        return;
      }
      text = block.code;
      what = `code block ${String(n)}${block.lang === '' ? '' : ` (${block.lang})`}`;
    }
    const how = await copyToClipboard(text);
    ctx.notice(
      'info',
      `Copied ${what} to the clipboard (${String(text.split('\n').length)} lines${how === 'osc52' ? ', via the terminal' : ''}).`,
    );
  },
};

export const skills: SlashCommand = {
  name: 'skills',
  description: 'Skills VinaX can load for specific tasks',
  source: 'builtin',
  run(ctx) {
    const list = ctx.setup.skills;
    ctx.panel(
      'Skills',
      [
        ...(list.length === 0
          ? ['No skills installed yet.']
          : list.map(
              (s) =>
                `- **${s.name}** _(${s.source})_ — ${s.description}\n  \`${shortenPath(s.dir)}\``,
            )),
        '',
        'A skill is a folder with a `SKILL.md` in `.vinax/skills/`, `.claude/skills/` or `~/.vinax/skills/`:',
        '',
        '```markdown',
        '---',
        'name: release-notes',
        'description: Write release notes from the git log in our house style',
        '---',
        'Steps and conventions VinaX should follow…',
        '```',
        '',
        'VinaX sees each skill’s name and description and loads the full instructions (with the Skill tool) when a task calls for it.',
      ].join('\n'),
    );
  },
};
