import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

describe('vinax -p with images', () => {
  it('attaches @image.png and answers with a vision-capable model', async () => {
    h = await createHarness({
      openrouter: {
        models: [
          {
            id: 'free-model:free',
            context_window: 131072,
            architecture: { input_modalities: ['text', 'image'] },
          },
        ],
        script: { 'free-model:free': [{ text: 'a single pixel' }] },
      },
    });
    await fs.writeFile(path.join(h.cwd, 'dot.png'), PNG);
    const r = await h.run(['-p', 'what is in @dot.png?']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('a single pixel');
    const body = h.openrouter.requests.find((q) => q.path === '/v1/chat/completions')?.body as {
      messages: { role: string; content: unknown }[];
    };
    const user = body.messages.find((m) => m.role === 'user');
    expect(JSON.stringify(user?.content)).toContain('data:image/png;base64,');
    expect(JSON.stringify(user?.content)).toContain('what is in [Image #1]?');
    expect(h.groq.requests.filter((q) => q.path === '/v1/chat/completions')).toHaveLength(0);
  });
});
