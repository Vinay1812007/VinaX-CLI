import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { parseFrontmatter } from '../commands/custom.js';
import { vinaxHome, type Env } from '../config/paths.js';
import { defineTool, type ToolContext } from '../tools/types.js';

export interface SubagentDef {
  name: string;
  description: string;
  /** Tool names (or `mcp__server__*` patterns) the sub-agent may use; undefined = all but Task. */
  tools: string[] | undefined;
  model: string | undefined;
  /** Its role, appended to the system prompt. */
  prompt: string;
  source: 'builtin' | 'project' | 'user';
  file?: string;
}

export const GENERAL_PURPOSE: SubagentDef = {
  name: 'general-purpose',
  description:
    'Researches questions and carries out multi-step tasks on its own, with every tool available.',
  tools: undefined,
  model: undefined,
  prompt:
    'You handle one delegated task end to end: search, read, run and change what is needed, then report back.',
  source: 'builtin',
};

function asList(v: string | string[] | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  const list = Array.isArray(v) ? v : v.split(',');
  const clean = list.map((s) => s.trim()).filter((s) => s !== '');
  return clean.length === 0 ? undefined : clean;
}

/** Sub-agents from `~/.vinax/agents/*.md` and `.vinax/agents/*.md` (project wins on a clash). */
export async function loadSubagents(
  cwd: string,
  env: Env,
): Promise<{ agents: SubagentDef[]; errors: string[] }> {
  const byName = new Map<string, SubagentDef>([[GENERAL_PURPOSE.name, GENERAL_PURPOSE]]);
  const errors: string[] = [];
  const sources = [
    { dir: path.join(vinaxHome(env), 'agents'), source: 'user' as const },
    { dir: path.join(cwd, '.vinax', 'agents'), source: 'project' as const },
  ];
  for (const { dir, source } of sources) {
    let names: string[];
    try {
      names = (await fs.readdir(dir)).filter((n) => n.endsWith('.md')).sort();
    } catch {
      continue;
    }
    for (const n of names) {
      const file = path.join(dir, n);
      const { data, body } = parseFrontmatter(await fs.readFile(file, 'utf8'));
      const name = typeof data.name === 'string' ? data.name : n.slice(0, -3);
      if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
        errors.push(`${file}: agent names use lowercase letters, digits and dashes`);
        continue;
      }
      if (typeof data.description !== 'string' || data.description.trim() === '') {
        errors.push(`${file}: add a description so VinaX knows when to use this agent`);
        continue;
      }
      const model =
        typeof data.model === 'string' && /^(groq|openrouter):\S+$/.test(data.model)
          ? data.model
          : undefined;
      byName.set(name, {
        name,
        description: data.description,
        tools: asList(data.tools),
        model,
        prompt: body.trim(),
        source,
        file,
      });
    }
  }
  return { agents: [...byName.values()], errors };
}

export type SubagentRunner = (
  def: SubagentDef,
  prompt: string,
  ctx: ToolContext,
) => Promise<{ text: string; toolCalls: number; ok: boolean }>;

export function createTaskTool(agents: readonly SubagentDef[], runner: SubagentRunner) {
  const list = agents.map((a) => `- ${a.name}: ${a.description}`).join('\n');
  return defineTool({
    name: 'Task',
    description: [
      'Delegate a self-contained task to a sub-agent with its own fresh context. Use it for broad searches or multi-step side work, so your own context stays small. The sub-agent cannot see this conversation: give it every detail it needs. You get back only its final report.',
      'Available agents:',
      list,
    ].join('\n'),
    input: z.object({
      description: z.string().min(1).describe('3–5 words describing the task'),
      prompt: z.string().min(1).describe('Complete instructions for the sub-agent'),
      subagent_type: z
        .string()
        .optional()
        .describe('Which agent to use (default: general-purpose)'),
    }),
    kind: 'meta',
    readOnly: false,
    label: (i) => `${i.subagent_type ?? GENERAL_PURPOSE.name}: ${i.description}`,
    target: () => ({}),
    async run(i, ctx) {
      const def = agents.find((a) => a.name === (i.subagent_type ?? GENERAL_PURPOSE.name));
      if (!def) {
        return {
          ok: false,
          content: `No agent named "${i.subagent_type ?? ''}". Available: ${agents.map((a) => a.name).join(', ')}.`,
          summary: 'Unknown agent',
        };
      }
      const r = await runner(def, i.prompt, ctx);
      return {
        ok: r.ok,
        content: r.text === '' ? '(the sub-agent returned no report)' : r.text,
        summary: `${r.ok ? 'Done' : 'Stopped'} · ${String(r.toolCalls)} tool call${r.toolCalls === 1 ? '' : 's'}`,
      };
    },
  });
}
