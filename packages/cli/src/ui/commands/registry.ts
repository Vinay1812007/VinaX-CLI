import {
  expandCommand,
  fuzzyScore,
  loadCustomCommands,
  type CustomCommand,
  type Runtime,
} from '@vinax/core';
import { BUILTIN_COMMANDS } from './builtins.js';
import type { SlashCommand } from './types.js';

function fromCustom(cmd: CustomCommand): SlashCommand {
  return {
    name: cmd.name,
    description: cmd.description,
    argumentHint: cmd.argumentHint,
    source: cmd.scope,
    async run(ctx) {
      const { prompt, warnings } = await expandCommand(cmd, ctx.args, {
        cwd: ctx.runtime.cwd,
        workspace: ctx.setup.workspace,
        runShell: async (command) =>
          (
            await ctx.setup.shell.run(command, {
              timeoutMs: 30_000,
              signal: AbortSignal.timeout(35_000),
            })
          ).output,
      });
      for (const w of warnings) ctx.notice('warning', w);
      ctx.send(prompt, {
        display: `/${cmd.name}${ctx.args === '' ? '' : ` ${ctx.args}`}`,
        allowRules: cmd.allowedTools,
        ...(cmd.model === undefined ? {} : { model: cmd.model }),
      });
    },
  };
}

/** Built-in plus custom commands; a custom command cannot shadow a built-in. */
export async function loadCommands(
  runtime: Runtime,
): Promise<{ commands: SlashCommand[]; warnings: string[] }> {
  const { commands: custom, errors } = await loadCustomCommands(runtime.cwd, runtime.env);
  const warnings = [...errors];
  const taken = new Set(BUILTIN_COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]));
  const extra: SlashCommand[] = [];
  for (const c of custom) {
    if (taken.has(c.name))
      warnings.push(
        `Custom command /${c.name} (${c.file}) has the same name as a built-in command and was skipped.`,
      );
    else extra.push(fromCustom(c));
  }
  return { commands: [...BUILTIN_COMMANDS, ...extra], warnings };
}

export function findCommand(
  commands: readonly SlashCommand[],
  name: string,
): SlashCommand | undefined {
  return commands.find((c) => c.name === name || (c.aliases ?? []).includes(name));
}

/** Commands for the `/` menu: prefix matches first, then fuzzy matches. */
export function matchCommands(
  commands: readonly SlashCommand[],
  query: string,
  limit = 8,
): SlashCommand[] {
  const q = query.toLowerCase();
  const prefix = commands.filter(
    (c) => c.name.startsWith(q) || (c.aliases ?? []).some((a) => a.startsWith(q)),
  );
  const fuzzy = commands
    .filter((c) => !prefix.includes(c))
    .map((c) => ({ c, s: fuzzyScore(q, c.name) }))
    .filter((x): x is { c: SlashCommand; s: number } => x.s !== undefined)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.c);
  return [...prefix, ...fuzzy].slice(0, limit);
}
