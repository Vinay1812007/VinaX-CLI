import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { parseFrontmatter } from '../commands/custom.js';
import { vinaxHome, type Env } from '../config/paths.js';
import { defineTool } from '../tools/types.js';

/**
 * A skill: a folder with a SKILL.md whose frontmatter names it and says when to use it. The
 * model sees only the names and descriptions up front and loads a skill's instructions with the
 * Skill tool when a task calls for it (the same layout Claude Code uses).
 */
export interface SkillDef {
  name: string;
  description: string;
  /** SKILL.md without its frontmatter. */
  body: string;
  /** The skill's folder (other files there can be read on demand). */
  dir: string;
  source: 'project' | 'user';
}

const MAX_SKILL_CHARS = 20_000;

/** Where skills live: the project's `.vinax/skills` and `.claude/skills`, then `~/.vinax/skills`. */
export function skillDirs(cwd: string, env: Env): { dir: string; source: SkillDef['source'] }[] {
  return [
    { dir: path.join(cwd, '.vinax', 'skills'), source: 'project' },
    { dir: path.join(cwd, '.claude', 'skills'), source: 'project' },
    { dir: path.join(vinaxHome(env), 'skills'), source: 'user' },
  ];
}

/** Loads every skill; a project skill wins over a user skill with the same name. */
export async function loadSkills(
  cwd: string,
  env: Env,
): Promise<{ skills: SkillDef[]; errors: string[] }> {
  const byName = new Map<string, SkillDef>();
  const errors: string[] = [];
  for (const { dir, source } of skillDirs(cwd, env)) {
    let names: string[];
    try {
      names = (await fs.readdir(dir, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
    } catch {
      continue;
    }
    for (const folder of names) {
      const file = path.join(dir, folder, 'SKILL.md');
      let text: string;
      try {
        text = await fs.readFile(file, 'utf8');
      } catch {
        continue;
      }
      const { data, body } = parseFrontmatter(text);
      const name = typeof data.name === 'string' ? data.name.trim() : folder;
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
        errors.push(`${file}: skill names use letters, digits, dashes and underscores`);
        continue;
      }
      if (typeof data.description !== 'string' || data.description.trim() === '') {
        errors.push(`${file}: add a description so VinaX knows when to use this skill`);
        continue;
      }
      if (byName.has(name)) continue;
      byName.set(name, {
        name,
        description: data.description.trim(),
        body: body.trim().slice(0, MAX_SKILL_CHARS),
        dir: path.join(dir, folder),
        source,
      });
    }
  }
  return { skills: [...byName.values()], errors };
}

/** The system-prompt section that lists skills (names and descriptions only). */
export function skillsPromptSection(skills: readonly SkillDef[]): string | undefined {
  if (skills.length === 0) return undefined;
  return [
    '# Skills',
    'These skills hold instructions for specific kinds of tasks. When a task matches one, call the Skill tool with its name first and follow what it says.',
    ...skills.map((s) => `- ${s.name}: ${s.description}`),
  ].join('\n');
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, depth: number): Promise<void> => {
    if (depth > 2 || out.length >= 30) return;
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (e.name !== 'SKILL.md') out.push(p);
    }
  };
  await walk(dir, 0);
  return out;
}

/** Loads a skill's instructions into the conversation. */
export function createSkillTool(skills: readonly SkillDef[]) {
  return defineTool({
    name: 'Skill',
    description: `Load the instructions of a skill before doing a task it covers. Available: ${skills.map((s) => s.name).join(', ') || '(none)'}.`,
    input: z.object({ name: z.string().min(1).describe('The skill name') }),
    kind: 'meta',
    readOnly: true,
    label: (i) => i.name,
    target: () => ({}),
    async run(i) {
      const skill = skills.find((s) => s.name === i.name);
      if (!skill) {
        return {
          ok: false,
          content: `No skill named "${i.name}". Available: ${skills.map((s) => s.name).join(', ') || 'none'}.`,
          summary: 'Unknown skill',
        };
      }
      const files = await listFiles(skill.dir);
      return {
        ok: true,
        content: [
          `<skill name="${skill.name}" folder="${skill.dir}">`,
          skill.body,
          ...(files.length === 0
            ? []
            : [
                '',
                'Other files in this skill (read them when the instructions refer to them):',
                ...files.map((f) => `- ${f}`),
              ]),
          '</skill>',
        ].join('\n'),
        summary: `Loaded ${skill.name}`,
      };
    },
  });
}
