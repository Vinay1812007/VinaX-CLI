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

const VISION_MODEL = {
  id: 'free-model:free',
  context_window: 131072,
  architecture: { input_modalities: ['text', 'image'] },
};

type Body = { messages: { role: string; content: unknown }[] };
const chats = (s: Harness['groq']) =>
  s.requests.filter((q) => q.path === '/v1/chat/completions').map((q) => q.body as Body);

describe('vinax -p with images', () => {
  it('has a vision model read @image.png and passes what it saw to the working model', async () => {
    h = await createHarness({
      groq: { script: { 'main-model': [{ text: 'The error is a missing semicolon.' }] } },
      openrouter: {
        models: [VISION_MODEL],
        script: { 'free-model:free': [{ text: 'Terminal shows: SyntaxError: missing ;' }] },
      },
    });
    await fs.writeFile(path.join(h.cwd, 'dot.png'), PNG);
    const r = await h.run(['-p', 'what is in @dot.png?']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('The error is a missing semicolon.');
    // the vision model got the image and the working agent's request
    const [seen] = chats(h.openrouter);
    const user = JSON.stringify(seen?.messages.find((m) => m.role === 'user')?.content);
    expect(user).toContain('data:image/png;base64,');
    expect(user).toContain('what is in [Image #1]?');
    // the working model got the description, not the image
    const [work] = chats(h.groq);
    const body = JSON.stringify(work?.messages);
    expect(body).not.toContain('image_url');
    expect(body).toContain('Terminal shows: SyntaxError: missing ;');
    expect(body).toContain('described-by=\\"openrouter:free-model:free\\"');
  });

  it('says how to read a screen recording when nothing can watch it', async () => {
    h = await createHarness({
      groq: { script: { 'main-model': [{ text: 'ok' }] } },
      settings: { fallbackChain: [] },
    });
    await fs.writeFile(path.join(h.cwd, 'rec.mov'), Buffer.alloc(64));
    const r = await h.run(['-p', 'why does @rec.mov flicker?']);
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/Can't read \[Video #1\] rec\.mov/);
    const body = JSON.stringify(chats(h.groq)[0]?.messages);
    expect(body).toContain('why does [Video #1] flicker?');
  });
});
