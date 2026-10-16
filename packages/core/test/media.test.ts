import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startMockServer, systemEnv, type MockServer } from '@vinax/testkit';
import {
  attachMentions,
  createAgentSetup,
  createRuntime,
  describeMedia,
  extractImages,
  findImagePaths,
  inferVideo,
  inferVision,
  MediaReader,
  ReadTracker,
  SessionStore,
  type AgentEvent,
  type ChatMessage,
  type RouteRequest,
  type RouterEvent,
  type ToolContext,
} from '../src/index.js';
import { readTool } from '../src/tools/file-tools.js';

const dirs: string[] = [];
const servers: MockServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});
async function tmp(): Promise<string> {
  const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vinax-media-')));
  dirs.push(d);
  return d;
}

/** A 1×1 transparent PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const png = (name = 'shot.png') => ({
  mediaType: 'image/png' as const,
  data: PNG.toString('base64'),
  name,
});

/** A router that answers every request with `reply` from `ref`, and keeps the requests. */
function fakeRouter(reply: string | Error = 'a description', ref = 'nvidia:eyes') {
  const requests: RouteRequest[] = [];
  const provider = ref.slice(0, ref.indexOf(':'));
  const model = ref.slice(ref.indexOf(':') + 1);
  return {
    requests,
    async *stream(req: RouteRequest): AsyncGenerator<RouterEvent> {
      requests.push(req);
      await Promise.resolve();
      yield { type: 'attempt', ref: { provider: provider as 'nvidia', model } };
      if (reply instanceof Error) throw reply;
      yield { type: 'text', text: reply };
      yield { type: 'done', ref: { provider: provider as 'nvidia', model }, usage: undefined };
    },
  };
}
const userOf = (req: RouteRequest | undefined) =>
  req?.messages.find((m) => m.role === 'user') as Extract<ChatMessage, { role: 'user' }>;
const signal = () => new AbortController().signal;
const task = { prompt: 'why does the build fail?', recap: 'User: fix the build' };

describe('describeMedia', () => {
  it('sends the media with the working agent’s task, without tools, and returns the text', async () => {
    const router = fakeRouter('Terminal: `error TS2322`');
    const r = await describeMedia({
      router,
      models: ['nvidia:eyes', 'openrouter:other'],
      task,
      signal: signal(),
      media: { images: [png()], intro: 'Attached: image 1.' },
    });
    expect(r).toEqual({ ok: true, text: 'Terminal: `error TS2322`', by: 'nvidia:eyes' });
    const req = router.requests[0];
    expect(req?.model).toBe('nvidia:eyes');
    expect(req?.fallbacks).toEqual(['openrouter:other']);
    expect(req).not.toHaveProperty('tools');
    expect(req?.messages[0]?.content).toContain('Transcribe all visible text verbatim');
    const user = userOf(req);
    expect(user.content).toContain('why does the build fail?');
    expect(user.content).toContain('User: fix the build');
    expect(user.images).toHaveLength(1);
  });

  it('returns a reason instead of throwing', async () => {
    const r = await describeMedia({
      router: fakeRouter(new Error('all models failed\nmore')),
      models: ['nvidia:eyes'],
      task,
      signal: signal(),
      media: { images: [png()], intro: '' },
    });
    expect(r).toEqual({ ok: false, reason: 'all models failed' });
    expect(
      await describeMedia({
        router: fakeRouter(),
        models: [],
        task,
        signal: signal(),
        media: { intro: '' },
      }),
    ).toMatchObject({ ok: false });
  });
});

describe('MediaReader', () => {
  it('describes the same image once per session', async () => {
    const router = fakeRouter();
    const reader = new MediaReader({ router, visionModels: () => ['nvidia:eyes'] });
    const notices: string[] = [];
    const opts = { task, signal: signal(), onNotice: (_: string, t: string) => notices.push(t) };
    const a = await reader.describeImages([png('a.png')], opts);
    const b = await reader.describeImages([png('b.png')], opts);
    expect(a).toMatchObject({ ok: true, note: { kind: 'image', names: ['a.png'] } });
    expect(b).toMatchObject({ ok: true, note: { names: ['b.png'], text: 'a description' } });
    expect(router.requests).toHaveLength(1);
    expect(notices).toEqual(['Reading a.png with nvidia:eyes.']);
  });

  it('says ffmpeg is missing (and how to install it) when no model takes video', async () => {
    const dir = await tmp();
    const file = path.join(dir, 'rec.mov');
    await fs.writeFile(file, Buffer.alloc(32));
    const router = fakeRouter();
    const reader = new MediaReader({
      router,
      visionModels: () => ['nvidia:eyes'],
      videoModels: () => [],
      platform: 'darwin',
      exec: () => Promise.reject(new Error('spawn ffmpeg ENOENT')),
    });
    const r = await reader.describeVideo(
      { path: file, name: 'rec.mov', size: 32 },
      {
        task,
        signal: signal(),
      },
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/ffmpeg is not installed.*brew install ffmpeg/);
    expect(router.requests).toHaveLength(0);
  });

  it('samples frames with ffmpeg and has them read in order, then cleans up', async () => {
    const dir = await tmp();
    const work = await tmp();
    const file = path.join(dir, 'rec.mp4');
    await fs.writeFile(file, Buffer.alloc(32));
    const calls: string[][] = [];
    let framesDir = '';
    const router = fakeRouter('At 0:02 the button turns red.');
    const reader = new MediaReader({
      router,
      visionModels: () => ['nvidia:eyes'],
      tmpDir: work,
      exec: async (cmd, args) => {
        calls.push([cmd, ...args]);
        if (cmd === 'ffprobe') return { stdout: '6.5\n' };
        const out = args.at(-1);
        if (cmd === 'ffmpeg' && out !== undefined && out.endsWith('.jpg')) {
          framesDir = path.dirname(out);
          for (const n of [1, 2, 3])
            await fs.writeFile(path.join(framesDir, `frame-00${String(n)}.jpg`), 'jpg');
        }
        return { stdout: '' };
      },
    });
    const r = await reader.describeVideo(
      { path: file, name: 'rec.mp4', size: 32 },
      {
        task,
        signal: signal(),
      },
    );
    expect(r).toMatchObject({
      ok: true,
      note: { kind: 'video', names: ['rec.mp4'], text: 'At 0:02 the button turns red.' },
    });
    const user = userOf(router.requests[0]);
    expect(user.images?.map((i) => i.name)).toEqual([
      'rec.mp4 @ 0:00',
      'rec.mp4 @ 0:02',
      'rec.mp4 @ 0:04',
    ]);
    expect(user.content).toContain('frame 2 at 0:02');
    expect(calls.find((c) => c[0] === 'ffmpeg' && c.includes('-i'))?.join(' ')).toContain(
      'fps=1/2.000',
    );
    await expect(fs.access(framesDir)).rejects.toThrow();
  });

  it('sends a recording whole to a model marked for video', async () => {
    const dir = await tmp();
    const file = path.join(dir, 'rec.mp4');
    await fs.writeFile(file, Buffer.from('fake mp4'));
    const router = fakeRouter('The user clicks Save; a 500 error appears.', 'nvidia:omni');
    const reader = new MediaReader({
      router,
      visionModels: () => ['nvidia:eyes'],
      videoModels: () => ['nvidia:omni'],
      exec: () => Promise.reject(new Error('must not run ffmpeg')),
    });
    const r = await reader.describeVideo(
      { path: file, name: 'rec.mp4', size: 8 },
      {
        task,
        signal: signal(),
      },
    );
    expect(r).toMatchObject({ ok: true, note: { by: 'nvidia:omni' } });
    expect(router.requests[0]?.model).toBe('nvidia:omni');
    expect(userOf(router.requests[0]).videos?.[0]?.mediaType).toBe('video/mp4');
  });
});

describe('finding recordings in prompts', () => {
  it('turns recording paths into [Video #n] chips next to images', async () => {
    const dir = await tmp();
    await fs.writeFile(path.join(dir, 'shot.png'), PNG);
    await fs.writeFile(path.join(dir, 'Screen Recording.mov'), Buffer.alloc(10));
    const r = await extractImages(
      `see @shot.png and ${dir}/Screen\\ Recording.mov and @gone.mp4`,
      dir,
    );
    expect(r.text).toBe('see [Image #1] and [Video #1] and @gone.mp4');
    expect(r.images).toHaveLength(1);
    expect(r.videos).toEqual([
      { path: path.join(dir, 'Screen Recording.mov'), name: 'Screen Recording.mov', size: 10 },
    ]);
    // findImagePaths still finds images only
    expect(findImagePaths('a.mov b.png /x/y.mp4 /x/z.png').map((f) => f.path)).toEqual([
      '/x/z.png',
    ]);
  });

  it('never drops an @mention silently', async () => {
    const dir = await tmp();
    await fs.writeFile(path.join(dir, 'rec.webm'), Buffer.alloc(10));
    await fs.writeFile(path.join(dir, 'blob.bin'), Buffer.from([1, 0, 2, 0]));
    await fs.writeFile(path.join(dir, 'huge.log'), 'x'.repeat(2_100_000));
    const r = await attachMentions('look at @rec.webm, @blob.bin and @huge.log', {
      cwd: dir,
      workspace: [dir],
      reads: new ReadTracker(),
    });
    expect(r.prompt).toContain('<file path="rec.webm">');
    expect(r.prompt).toContain('Use the Read tool on this path');
    expect(r.attached).toEqual(['rec.webm']);
    expect(r.skipped).toEqual([
      '@blob.bin was not attached: it is a binary file.',
      expect.stringContaining('@huge.log was not attached: it is 2.1 MB'),
    ]);
  });
});

describe('Read on media', () => {
  const ctx = (cwd: string, readMedia?: ToolContext['readMedia']): ToolContext =>
    ({
      cwd,
      workspace: [cwd],
      reads: new ReadTracker(),
      signal: signal(),
      ...(readMedia === undefined ? {} : { readMedia }),
    }) as unknown as ToolContext;

  it('returns a description of an image instead of failing on binary', async () => {
    const dir = await tmp();
    await fs.writeFile(path.join(dir, 'ui.png'), PNG);
    const seen: string[] = [];
    const out = await readTool.run(
      { file_path: 'ui.png' },
      ctx(dir, (file) => {
        seen.push(file);
        return Promise.resolve({ ok: true, text: '<attachment>Login form</attachment>' });
      }),
    );
    expect(out).toMatchObject({ ok: true, content: '<attachment>Login form</attachment>' });
    expect(seen).toEqual([path.join(dir, 'ui.png')]);
    // without a reader it is still refused as binary
    await expect(readTool.run({ file_path: 'ui.png' }, ctx(dir))).rejects.toThrow(/binary/);
  });
});

describe('vision inference', () => {
  it('recognises well-known multimodal families and nothing else', () => {
    for (const id of [
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4.1',
      'gpt-5',
      'o3',
      'o4-mini',
      'claude-opus-4-1',
      'gemini-2.0-flash',
      'meta/llama-3.2-90b-vision-instruct',
      'qwen/qwen2.5-vl-72b-instruct',
      'meta/llama-4-maverick-17b-128e-instruct',
      'google/gemma-3-27b-it',
      'mistralai/pixtral-12b',
    ])
      expect(inferVision(id), id).toBe(true);
    for (const id of [
      'openai/gpt-oss-20b',
      'gpt-3.5-turbo',
      'o3-mini',
      'gpt-4o-audio-preview',
      'gpt-4o-mini-tts',
      'text-embedding-3-small',
      'deepseek-chat',
      'llama-3.3-70b-versatile',
      'google/gemma-3-1b-it',
    ])
      expect(inferVision(id), id).toBe(false);
    expect(inferVideo('nvidia/nemotron-3-nano-omni-30b-a3b-reasoning')).toBe(true);
    expect(inferVideo('nvidia/cosmos3-nano-reasoner')).toBe(true);
    expect(inferVideo('gpt-4o')).toBe(false);
  });
});

describe('sessions keep media descriptions', () => {
  it('round-trips mediaNotes through save and load', async () => {
    const root = await tmp();
    const store = new SessionStore(path.join(root, 'data'), root);
    const w = store.create();
    const message: ChatMessage = {
      role: 'user',
      content: 'what is in [Image #1]?',
      images: [png()],
      mediaNotes: [{ kind: 'image', names: ['shot.png'], by: 'nvidia:eyes', text: 'A red error' }],
    };
    w.record({ type: 'message', message });
    const loaded = store.load(w.id);
    expect(loaded.messages).toEqual([message]);
  });
});

describe('the working model with images', () => {
  it('gets images natively when it can see them, and nothing is described', async () => {
    const home = await tmp();
    const cwd = path.join(home, 'project');
    await fs.mkdir(cwd);
    const groq = await startMockServer({
      models: [{ id: 'eyes', architecture: { input_modalities: ['text', 'image'] } }],
      script: { eyes: [{ text: 'a pixel' }] },
    });
    servers.push(groq);
    await fs.writeFile(
      path.join(home, 'settings.json'),
      JSON.stringify({
        model: 'groq:eyes',
        smallModel: 'groq:eyes',
        fallbackChain: [],
        providers: { groq: { baseUrl: groq.url }, nvidia: { enabled: false } },
        router: { maxRetries: 0 },
      }),
    );
    const runtime = await createRuntime({
      cwd,
      env: {
        ...systemEnv(),
        VINAX_HOME: home,
        VINAX_SECRETS_BACKEND: 'file',
        GROQ_API_KEY: 'gsk_x0000000',
      },
    });
    const setup = await createAgentSetup(runtime, { mcp: false });
    const events: AgentEvent[] = [];
    const out = await setup.agent.run('what is this?', {
      signal: signal(),
      host: {
        mode: () => 'default' as const,
        askPermission: () => Promise.resolve({ kind: 'deny' as const, feedback: '' }),
      },
      onEvent: (e) => events.push(e),
      images: [png('dot.png')],
    });
    expect(out.text).toBe('a pixel');
    const chats = groq.requests.filter((r) => r.path === '/v1/chat/completions');
    expect(chats).toHaveLength(1);
    expect(JSON.stringify(chats[0]?.body)).toContain('image_url');
    expect(events.some((e) => e.type === 'notice' && e.text.startsWith('Reading'))).toBe(false);
    expect(setup.agent.messages[0]).not.toHaveProperty('mediaNotes');
    await setup.close();
  });
});
