import type { Router } from '../router/router.js';

/** A 3–6 word title for the resume picker, from the first prompt (small model, one request). */
export async function generateTitle(
  router: Router,
  prompt: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  let text = '';
  try {
    for await (const ev of router.stream({
      purpose: 'small',
      noFallback: true,
      signal,
      maxTokens: 24,
      messages: [
        {
          role: 'system',
          content:
            'Write a 3–6 word title for a coding session, in sentence case, with no quotes or final punctuation. Reply with the title only.',
        },
        { role: 'user', content: prompt.slice(0, 1500) },
      ],
    })) {
      if (ev.type === 'text') text += ev.text;
    }
  } catch {
    return undefined;
  }
  const title = text
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '');
  return title === undefined ? undefined : title.replace(/^["'#*\s]+|["'.*\s]+$/g, '').slice(0, 60);
}
