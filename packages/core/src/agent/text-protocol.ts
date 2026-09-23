import type { ChatMessage, ToolSpec } from '../providers/types.js';

const OPEN = '<vx:call';
const CLOSE = '</vx:call>';
const RESULT = '<vx:result';

export interface TextCall {
  name: string;
  arguments: string;
}

/** Instructions appended to the system prompt when a model uses the text tool protocol. */
export function textProtocolInstructions(tools: readonly ToolSpec[]): string {
  const list = tools
    .map(
      (t) =>
        `### ${t.name}\n${t.description}\nArguments (JSON Schema): ${JSON.stringify(t.parameters)}`,
    )
    .join('\n\n');
  return [
    '# Calling tools',
    'To use a tool, write a call block like this, on its own lines, outside any code fence:',
    '',
    '<vx:call name="Read">',
    '{"file_path": "src/index.ts"}',
    '</vx:call>',
    '',
    'The body is one JSON object with the arguments. You can make several calls in one reply. Stop after your calls: the results come back in the next message inside <vx:result> blocks. Never write <vx:result> yourself.',
    '',
    '## Tools',
    list,
  ].join('\n');
}

function renderCall(name: string, args: string): string {
  return `<vx:call name="${name}">\n${args}\n</vx:call>`;
}

/**
 * Rewrites a native tool-calling history into plain text for the text protocol: assistant tool
 * calls become <vx:call> blocks, and tool results become one user message of <vx:result> blocks.
 */
export function toTextProtocol(messages: readonly ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  let results: string[] = [];
  const flush = (): void => {
    if (results.length > 0) out.push({ role: 'user', content: results.join('\n\n') });
    results = [];
  };
  for (const m of messages) {
    if (m.role === 'tool') {
      results.push(`<vx:result name="${m.name}">\n${m.content}\n</vx:result>`);
      continue;
    }
    flush();
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      const calls = m.toolCalls.map((c) => renderCall(c.name, c.arguments)).join('\n');
      out.push({
        role: 'assistant',
        content: m.content === '' ? calls : `${m.content}\n\n${calls}`,
      });
    } else {
      out.push(m);
    }
  }
  flush();
  return out;
}

/** Longest suffix of `text` that is a prefix of `token` (a tag possibly split across chunks). */
function partialSuffix(text: string, token: string): number {
  for (let n = Math.min(token.length - 1, text.length); n > 0; n--) {
    if (token.startsWith(text.slice(text.length - n))) return n;
  }
  return 0;
}

/**
 * Pulls <vx:call> blocks out of streamed text. Visible text is released as soon as it cannot be
 * the start of a tag, so the answer still streams; calls are returned once their block closes.
 */
export class TextCallParser {
  private buf = '';
  private inCall = false;
  private callName = '';
  private stopped = false;

  push(chunk: string): { text: string; calls: TextCall[] } {
    if (this.stopped) return { text: '', calls: [] };
    this.buf += chunk;
    let text = '';
    const calls: TextCall[] = [];
    for (;;) {
      if (!this.inCall) {
        const resultAt = this.buf.indexOf(RESULT);
        const openAt = this.buf.indexOf(OPEN);
        if (resultAt !== -1 && (openAt === -1 || resultAt < openAt)) {
          // the model started inventing tool results: drop the rest of the reply
          text += this.buf.slice(0, resultAt);
          this.buf = '';
          this.stopped = true;
          break;
        }
        if (openAt === -1) {
          const hold = Math.max(partialSuffix(this.buf, OPEN), partialSuffix(this.buf, RESULT));
          text += this.buf.slice(0, this.buf.length - hold);
          this.buf = this.buf.slice(this.buf.length - hold);
          break;
        }
        const tagEnd = this.buf.indexOf('>', openAt);
        text += this.buf.slice(0, openAt);
        this.buf = this.buf.slice(openAt);
        if (tagEnd === -1) break; // opening tag still arriving
        const tag = this.buf.slice(0, tagEnd - openAt + 1);
        this.callName = /name\s*=\s*["']([^"']+)["']/.exec(tag)?.[1] ?? '';
        this.buf = this.buf.slice(tag.length);
        this.inCall = true;
      }
      const closeAt = this.buf.indexOf(CLOSE);
      if (closeAt === -1) break;
      calls.push({ name: this.callName, arguments: this.buf.slice(0, closeAt).trim() });
      this.buf = this.buf.slice(closeAt + CLOSE.length);
      this.inCall = false;
    }
    return { text, calls };
  }

  /** End of stream: releases held-back text; an unclosed call is returned as-is. */
  flush(): { text: string; calls: TextCall[] } {
    if (this.stopped) return { text: '', calls: [] };
    if (this.inCall) {
      const call = { name: this.callName, arguments: this.buf.trim() };
      this.buf = '';
      this.inCall = false;
      return { text: '', calls: [call] };
    }
    const text = this.buf;
    this.buf = '';
    return { text, calls: [] };
  }
}

/** Removes code fences the model wrapped around its calls, which would otherwise be left empty. */
export function tidyVisibleText(text: string): string {
  return text
    .replace(/```[\w-]*\s*```/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
