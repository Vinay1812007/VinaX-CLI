import type { ChatMessage } from './providers/types.js';

/** The conversation as a readable Markdown document (for /export). */
export function conversationMarkdown(
  messages: readonly ChatMessage[],
  meta: { title?: string; cwd: string; date: Date },
): string {
  const out = [
    `# ${meta.title ?? 'VinaX session'}`,
    '',
    `_Exported ${meta.date.toISOString().slice(0, 16).replace('T', ' ')} · ${meta.cwd}_`,
    '',
  ];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push('## You', '', m.content.trim(), '');
    } else if (m.role === 'assistant') {
      out.push('## VinaX', '');
      if (m.content.trim() !== '') out.push(m.content.trim(), '');
      for (const c of m.toolCalls ?? [])
        out.push(`> **${c.name}** \`${c.arguments.replace(/`/g, "'")}\``, '');
    } else if (m.role === 'tool') {
      const body = m.content.length > 3000 ? `${m.content.slice(0, 3000)}\n…` : m.content;
      out.push(
        `<details><summary>${m.name} result</summary>`,
        '',
        '```',
        body.replace(/```/g, "'''"),
        '```',
        '',
        '</details>',
        '',
      );
    }
  }
  return `${out.join('\n').trim()}\n`;
}
