import fs from 'node:fs/promises';
import path from 'node:path';
import { parseFrontmatter } from '../commands/custom.js';
import { vinaxHome, type Env } from '../config/paths.js';

/**
 * How VinaX writes its answers. A style replaces the "# Answering" section of the system prompt,
 * so it changes the voice and shape of replies without touching how the work itself is done:
 * every style still reads before it edits, runs the tests and refuses to invent output.
 */
export interface OutputStyle {
  /** Lower-case id used by `/output-style <name>` and the `outputStyle` setting. */
  name: string;
  description: string;
  /** The "# Answering" section this style uses instead of the built-in one. */
  prompt: string;
  source: 'builtin' | 'user' | 'project';
  /** Where a custom style was read from. */
  file?: string;
}

/** The answering rules VinaX uses when no style is chosen. */
export const DEFAULT_ANSWERING = `# Answering
- Be brief and direct. Use GitHub-flavored Markdown with language tags on code blocks.
- Point to code as path:line.
- When the task is done, summarize what changed and how you checked it in a few lines.`;

const EXPLANATORY = `# Answering
- Use GitHub-flavored Markdown with language tags on code blocks, and point to code as path:line.
- As you work, explain the reasoning behind what you are doing: why this approach rather than the obvious alternative, what the surrounding code made you do, and which trade-off you accepted.
- When you meet something worth knowing about this codebase — a pattern it follows, a constraint, a surprise — say so in a short "Why this way" aside instead of leaving it implicit.
- Explain, do not pad: no restating the request, no narrating tool calls, no summaries of what the user can already see.
- When the task is done, summarize what changed, how you checked it, and what someone maintaining this code later would need to know.`;

const LEARNING = `# Answering
- Use GitHub-flavored Markdown with language tags on code blocks, and point to code as path:line.
- You are working *with* the user, not for them: do the groundwork, then leave one well-chosen piece of the implementation for them to write.
- Choose a piece that teaches something — the core decision, the tricky condition, the heart of the algorithm — not boilerplate. Write everything around it, and mark the gap with a \`TODO(human)\` comment saying exactly what belongs there and why it matters.
- Then stop and tell the user what you left them, what it needs to do, and what you already know about the inputs and the expected result. Do not fill it in yourself unless they ask.
- When they write it, review it honestly: say what works, what breaks, and what you would change, with the reason.
- Keep explanations short and concrete. Teach through the code in front of you, not through general advice.`;

const CONCISE = `# Answering
- Answer in as few words as the question allows. One line when one line is enough.
- No preamble, no restating the request, no closing offers of further help.
- Use Markdown only where it carries meaning: code blocks, and lists of more than two items.
- Point to code as path:line.
- When the task is done, say what changed and how you checked it, in one or two lines.`;

export const BUILTIN_OUTPUT_STYLES: readonly OutputStyle[] = [
  {
    name: 'default',
    description: 'Brief and direct — built for getting work done',
    prompt: DEFAULT_ANSWERING,
    source: 'builtin',
  },
  {
    name: 'explanatory',
    description: 'Explains the reasoning and the codebase as it works',
    prompt: EXPLANATORY,
    source: 'builtin',
  },
  {
    name: 'learning',
    description: 'Leaves you a TODO(human) to write, then reviews it',
    prompt: LEARNING,
    source: 'builtin',
  },
  {
    name: 'concise',
    description: 'The shortest answer that is still complete',
    prompt: CONCISE,
    source: 'builtin',
  },
];

/** What VinaX answers in when nothing else is chosen or a chosen style has gone missing. */
export const DEFAULT_OUTPUT_STYLE: OutputStyle = BUILTIN_OUTPUT_STYLES[0] ?? {
  name: 'default',
  description: 'Brief and direct',
  prompt: DEFAULT_ANSWERING,
  source: 'builtin',
};

const NAME = /^[a-z0-9][a-z0-9_-]*$/;

/** A style file name or `name:` turned into an id: lower case, spaces as dashes. */
export function styleId(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '-');
}

async function readDir(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).filter((n) => n.endsWith('.md')).sort();
  } catch {
    return [];
  }
}

/**
 * Built-in styles plus any in `~/.vinax/output-styles/` and `.vinax/output-styles/`. A custom
 * style may take a built-in name to replace it; a project style wins over a user one.
 */
export async function loadOutputStyles(
  cwd: string,
  env: Env,
): Promise<{ styles: OutputStyle[]; errors: string[] }> {
  const errors: string[] = [];
  const byName = new Map<string, OutputStyle>(BUILTIN_OUTPUT_STYLES.map((s) => [s.name, s]));
  const sources = [
    { dir: path.join(vinaxHome(env), 'output-styles'), source: 'user' as const },
    { dir: path.join(cwd, '.vinax', 'output-styles'), source: 'project' as const },
  ];
  for (const { dir, source } of sources) {
    for (const entry of await readDir(dir)) {
      const file = path.join(dir, entry);
      let text;
      try {
        text = await fs.readFile(file, 'utf8');
      } catch {
        continue;
      }
      const { data, body } = parseFrontmatter(text);
      const name = styleId(typeof data.name === 'string' ? data.name : entry.slice(0, -3));
      if (!NAME.test(name)) {
        errors.push(`${file}: style names may only use lower-case letters, digits, - and _`);
        continue;
      }
      if (body.trim() === '') {
        errors.push(`${file}: the file has no instructions under its frontmatter`);
        continue;
      }
      byName.set(name, {
        name,
        description:
          typeof data.description === 'string' && data.description !== ''
            ? data.description
            : `Custom style from ${path.basename(dir)}/${entry}`,
        // a style file is written as the instructions themselves; give it the heading if it has none
        prompt: /^#\s/m.test(body.trim()) ? body.trim() : `# Answering\n${body.trim()}`,
        source,
        file,
      });
    }
  }
  const styles = [...byName.values()].sort((a, b) =>
    a.name === 'default' ? -1 : b.name === 'default' ? 1 : a.name.localeCompare(b.name),
  );
  return { styles, errors };
}

/** The template `/output-style new` writes, so a new style starts from something that works. */
export function styleTemplate(name: string): string {
  return `---
name: ${name}
description: Say in one line what this style is for
---

Replace this with how VinaX should answer while this style is on. It stands in for VinaX's
own answering rules, so say everything that matters: how long replies should be, how much
explanation to give, and what to do when a task is finished.

How the work is done does not change here — VinaX still reads before it edits, runs the
project's tests, and never invents output.
`;
}
