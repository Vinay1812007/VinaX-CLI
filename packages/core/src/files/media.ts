import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  ImageAttachment,
  MediaNote,
  VideoAttachment,
  VideoMediaType,
} from '../providers/types.js';
import type { Router } from '../router/router.js';
import { loadImage, looksLikeVideoPath, type VideoFile } from './images.js';

export { looksLikeVideoPath, VIDEO_EXT, type VideoFile } from './images.js';

const execFileAsync = promisify(execFile);

/** Recordings up to this size go to a video-capable model whole; bigger ones are sampled. */
export const MAX_VIDEO_BYTES = 50_000_000;
/** At most this many frames are sampled from a recording… */
export const MAX_FRAMES = 12;
/** …about one every this many seconds (further apart for long recordings). */
export const FRAME_EVERY_S = 2;
/** Longest side of a sampled frame, in pixels. */
const FRAME_MAX_PX = 1280;
const MAX_PROMPT_CHARS = 2000;
const MAX_RECAP_CHARS = 2000;

/** The type to send a video as, for formats video models take inline; else `undefined`. */
export function videoMediaType(p: string): VideoMediaType | undefined {
  const ext = path.extname(p).toLowerCase();
  if (ext === '.mp4' || ext === '.m4v') return 'video/mp4';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.webm') return 'video/webm';
  return undefined;
}

/** What the working agent is doing, so the model that looks can answer what it needs. */
export interface MediaTask {
  /** The user's current request to the working agent. */
  prompt: string;
  /** A short recap of the last few turns. */
  recap?: string;
  /** What the agent wants from this media in particular. */
  goal?: string;
}

export const DESCRIBER_PROMPT = `You are the eyes of another AI coding agent. That agent cannot see images or video, so it will only know what you write here. Describe the attached media for it, in service of its task:

1. Transcribe all visible text verbatim: code, error messages, stack traces, terminal output, log lines, file names, paths, URLs, UI labels, menu items, numbers. Put code and terminal output in fenced code blocks and keep line breaks and indentation.
2. Describe the layout and state: which app or page this is, panels and their contents, what is selected, highlighted, disabled, focused or showing an error, open dialogs, and diagrams or charts (axes, values, arrows and what they connect). Mention colours only where they carry meaning.
3. For a screen recording or a sequence of frames, describe what happens in order, with timestamps, and call out the moment something changes or goes wrong.
4. Then answer directly what the agent needs to know for its task.
5. Say plainly what you cannot read or are unsure of. Never guess text, and never invent details.

Write plain Markdown. No preamble, and do not address the user.`;

export interface DescribeRequest {
  router: Pick<Router, 'stream'>;
  /** Models that can take the media, best first; the first that answers writes the description. */
  models: readonly string[];
  task: MediaTask;
  media: { images?: ImageAttachment[]; videos?: VideoAttachment[]; intro: string };
  signal: AbortSignal;
  maxTokens?: number;
}

export type DescribeResult = { ok: true; text: string; by: string } | { ok: false; reason: string };

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** The working agent's context, as the describing model reads it. */
export function describeTaskText(task: MediaTask): string {
  const parts = [
    `<agent-task>\nThe user's request to the agent:\n${clip(task.prompt.trim(), MAX_PROMPT_CHARS) || '(none)'}\n</agent-task>`,
  ];
  const recap = task.recap?.trim() ?? '';
  if (recap !== '')
    parts.push(`<recent-conversation>\n${clip(recap, MAX_RECAP_CHARS)}\n</recent-conversation>`);
  parts.push(`What the agent needs from this: ${task.goal ?? 'everything relevant to its task.'}`);
  return parts.join('\n\n');
}

/**
 * Has a model that can see describe images or a video for a working agent that cannot. Never
 * throws: a failure comes back as `{ ok: false, reason }`.
 */
export async function describeMedia(req: DescribeRequest): Promise<DescribeResult> {
  const [head, ...rest] = req.models;
  if (head === undefined) return { ok: false, reason: 'no model that can see it is available' };
  let text = '';
  let by = head;
  try {
    for await (const ev of req.router.stream({
      purpose: 'main',
      model: head,
      fallbacks: rest,
      signal: req.signal,
      maxTokens: req.maxTokens ?? 2000,
      messages: [
        { role: 'system', content: DESCRIBER_PROMPT },
        {
          role: 'user',
          content: `${describeTaskText(req.task)}\n\n${req.media.intro}`,
          ...(req.media.images === undefined ? {} : { images: req.media.images }),
          ...(req.media.videos === undefined ? {} : { videos: req.media.videos }),
        },
      ],
    })) {
      if (ev.type === 'attempt') {
        by = `${ev.ref.provider}:${ev.ref.model}`;
        text = '';
      } else if (ev.type === 'text') text += ev.text;
    }
  } catch (err) {
    if (req.signal.aborted) return { ok: false, reason: 'interrupted' };
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: msg.split('\n')[0] ?? msg };
  }
  text = text.trim();
  if (text === '') return { ok: false, reason: `${by} returned an empty description` };
  return { ok: true, text, by };
}

/** Media notes as the working model reads them, after the user's message or a Read. */
export function renderMediaNotes(notes: readonly MediaNote[]): string {
  return notes
    .map((n) => {
      const by = n.by === undefined ? '' : ` described-by="${n.by}"`;
      return `<attachment kind="${n.kind}" name="${n.names.join(', ')}"${by}>\n${n.text}\n</attachment>`;
    })
    .join('\n\n');
}

/** The header that tells the working model where a description came from. */
export const MEDIA_NOTES_HEADER =
  'You cannot see the attached media, so a model that can wrote down what it shows (text transcribed verbatim). Treat it as what the user showed you; use Read on a file path to have it looked at again with a new question.';

export function ffmpegInstallHint(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return 'brew install ffmpeg';
  if (platform === 'win32') return 'winget install ffmpeg';
  return 'sudo apt install ffmpeg (or your package manager)';
}

export const NO_VISION_MODEL =
  'No vision-capable model is available, so the model only sees the image file names. Set `visionModel` in settings, or add a key for a provider with vision models.';

type Exec = (
  cmd: string,
  args: readonly string[],
  opts: { timeout: number; signal?: AbortSignal },
) => Promise<{ stdout: string }>;

const defaultExec: Exec = async (cmd, args, opts) => {
  const { stdout } = await execFileAsync(cmd, [...args], {
    timeout: opts.timeout,
    maxBuffer: 10 * 1024 * 1024,
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  });
  return { stdout };
};

export interface MediaReaderDeps {
  router: Pick<Router, 'stream'>;
  /** Models that accept images, best first. */
  visionModels: () => readonly string[];
  /** Models marked `video: true`, best first. */
  videoModels?: () => readonly string[];
  /** Runs ffmpeg/ffprobe (injectable for tests). */
  exec?: Exec;
  tmpDir?: string;
  platform?: NodeJS.Platform;
}

export interface ReadMediaOptions {
  task: MediaTask;
  signal: AbortSignal;
  /** How the media is named in notices, e.g. `[Image #1]`. */
  label?: string;
  /** Appended to the "Reading…" notice, e.g. why another model is looking. */
  reason?: string;
  onNotice?: (level: 'info' | 'warning', text: string) => void;
}

export type ReadMediaResult = { ok: true; note: MediaNote } | { ok: false; error: string };

function timestamp(seconds: number): string {
  const s = Math.round(seconds);
  return `${String(Math.floor(s / 60))}:${String(s % 60).padStart(2, '0')}`;
}

function hash(...parts: string[]): string {
  const h = createHash('sha256');
  for (const p of parts) h.update(p).update('\0');
  return h.digest('hex');
}

/**
 * Reads images and screen recordings for a working model that cannot: a vision model (or a
 * video model) describes them with the agent's task in mind. Descriptions are cached by content
 * for the session, so the same screenshot is described once.
 */
export class MediaReader {
  private readonly cache = new Map<string, MediaNote>();
  private readonly exec: Exec;

  constructor(private readonly deps: MediaReaderDeps) {
    this.exec = deps.exec ?? defaultExec;
  }

  async describeImages(
    images: readonly ImageAttachment[],
    opts: ReadMediaOptions,
  ): Promise<ReadMediaResult> {
    const names = images.map((img, i) => img.name ?? `image ${String(i + 1)}`);
    const key = `image:${hash(...images.map((i) => i.data))}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return { ok: true, note: { ...cached, names } };
    const models = this.deps.visionModels();
    if (models.length === 0) return { ok: false, error: NO_VISION_MODEL };
    const label = opts.label ?? names.join(', ');
    opts.onNotice?.('info', `Reading ${label} with ${models[0] ?? ''}${opts.reason ?? ''}.`);
    const r = await describeMedia({
      router: this.deps.router,
      models,
      task: opts.task,
      signal: opts.signal,
      media: {
        images: [...images],
        intro: `Attached: ${names.map((n, i) => `image ${String(i + 1)} (${n})`).join(', ')}.`,
      },
    });
    if (!r.ok) return { ok: false, error: `Could not read ${label}: ${r.reason}` };
    if (r.by !== models[0]) opts.onNotice?.('info', `${r.by} read ${label} instead.`);
    const note: MediaNote = { kind: 'image', names, by: r.by, text: r.text };
    this.cache.set(key, note);
    return { ok: true, note };
  }

  async describeVideo(file: VideoFile, opts: ReadMediaOptions): Promise<ReadMediaResult> {
    const stat = await fs.stat(file.path).catch(() => undefined);
    if (!stat) return { ok: false, error: `Can't read ${file.name}: file not found` };
    const key = `video:${hash(path.resolve(file.path), String(stat.size), String(stat.mtimeMs))}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return { ok: true, note: cached };
    const label = opts.label ?? file.name;
    const failures: string[] = [];

    // 1. A model that takes video directly, when the file is small enough to send.
    const videoModels = this.deps.videoModels?.() ?? [];
    const type = videoMediaType(file.path);
    if (videoModels.length > 0 && type !== undefined && stat.size <= MAX_VIDEO_BYTES) {
      opts.onNotice?.(
        'info',
        `Watching ${label} with ${videoModels[0] ?? ''}${opts.reason ?? ''}.`,
      );
      const data = (await fs.readFile(file.path)).toString('base64');
      const r = await describeMedia({
        router: this.deps.router,
        models: videoModels,
        task: opts.task,
        signal: opts.signal,
        maxTokens: 3000,
        media: {
          videos: [{ mediaType: type, data, name: file.name }],
          intro: `Attached: the screen recording ${file.name}.`,
        },
      });
      if (r.ok) {
        const note: MediaNote = { kind: 'video', names: [file.name], by: r.by, text: r.text };
        this.cache.set(key, note);
        return { ok: true, note };
      }
      if (opts.signal.aborted) return { ok: false, error: `Could not read ${label}: interrupted` };
      failures.push(`the video model failed (${r.reason})`);
    }

    // 2. Frames sampled with ffmpeg, read by a vision model as an ordered sequence.
    const models = this.deps.visionModels();
    if (models.length === 0) {
      return {
        ok: false,
        error: `Can't read ${label}: ${[...failures, 'no model that can see images or video is available'].join('; ')}. Set \`visionModel\` in settings, or add a key for a provider with vision models.`,
      };
    }
    const frames = await this.sampleFrames(file, opts.signal);
    if ('error' in frames) {
      return {
        ok: false,
        error: `Can't read ${label}: ${[...failures, frames.error].join('; ')}`,
      };
    }
    const when = frames.images
      .map((_, i) => `frame ${String(i + 1)} at ${timestamp(i * frames.every)}`)
      .join(', ');
    opts.onNotice?.(
      'info',
      `Reading ${label} as ${String(frames.images.length)} frames with ${models[0] ?? ''}${opts.reason ?? ''}.`,
    );
    const r = await describeMedia({
      router: this.deps.router,
      models,
      task: opts.task,
      signal: opts.signal,
      maxTokens: 3000,
      media: {
        images: frames.images,
        intro: `Attached: ${String(frames.images.length)} frames sampled in order from the screen recording ${file.name}${frames.duration === undefined ? '' : ` (${timestamp(frames.duration)} long)`}, about one every ${frames.every.toFixed(1)}s: ${when}. Describe what happens over time, citing the timestamps.`,
      },
    });
    if (!r.ok) return { ok: false, error: `Could not read ${label}: ${r.reason}` };
    const note: MediaNote = { kind: 'video', names: [file.name], by: r.by, text: r.text };
    this.cache.set(key, note);
    return { ok: true, note };
  }

  /** Describes an image or video file (the Read tool). */
  async describeFile(file: string, opts: ReadMediaOptions): Promise<ReadMediaResult> {
    const name = path.basename(file);
    if (looksLikeVideoPath(file)) {
      const stat = await fs.stat(file).catch(() => undefined);
      if (!stat) return { ok: false, error: `File not found: ${file}` };
      return this.describeVideo({ path: file, name, size: stat.size }, opts);
    }
    let image: ImageAttachment;
    try {
      image = await loadImage(file);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    return this.describeImages([image], { ...opts, label: opts.label ?? name });
  }

  /** Up to {@link MAX_FRAMES} JPEG frames from a recording, read into memory; temp files removed. */
  private async sampleFrames(
    file: VideoFile,
    signal: AbortSignal,
  ): Promise<{ images: ImageAttachment[]; every: number; duration?: number } | { error: string }> {
    try {
      await this.exec('ffmpeg', ['-version'], { timeout: 10_000 });
    } catch {
      return {
        error: `ffmpeg is not installed, so VinaX cannot sample its frames. Install it (${ffmpegInstallHint(this.deps.platform)}) and try again`,
      };
    }
    let duration: number | undefined;
    try {
      const { stdout } = await this.exec(
        'ffprobe',
        [
          '-v',
          'error',
          '-show_entries',
          'format=duration',
          '-of',
          'default=noprint_wrappers=1:nokey=1',
          file.path,
        ],
        { timeout: 15_000, signal },
      );
      const d = Number.parseFloat(stdout.trim());
      if (Number.isFinite(d) && d > 0) duration = d;
    } catch {
      // no ffprobe or an odd container: sample at the default rate
    }
    const every =
      duration === undefined ? FRAME_EVERY_S : Math.max(FRAME_EVERY_S, duration / MAX_FRAMES);
    const dir = await fs.mkdtemp(path.join(this.deps.tmpDir ?? os.tmpdir(), 'vinax-frames-'));
    try {
      const px = String(FRAME_MAX_PX);
      await this.exec(
        'ffmpeg',
        [
          '-v',
          'error',
          '-nostdin',
          '-i',
          file.path,
          '-vf',
          `fps=1/${every.toFixed(3)},scale='if(gt(iw,ih),min(${px},iw),-2)':'if(gt(iw,ih),-2,min(${px},ih))'`,
          '-frames:v',
          String(MAX_FRAMES),
          '-q:v',
          '5',
          path.join(dir, 'frame-%03d.jpg'),
        ],
        { timeout: 120_000, signal },
      );
      const names = (await fs.readdir(dir)).filter((n) => n.endsWith('.jpg')).sort();
      if (names.length === 0) return { error: `ffmpeg found no frames in ${file.name}` };
      const images = await Promise.all(
        names.map(async (n, i): Promise<ImageAttachment> => ({
          mediaType: 'image/jpeg',
          data: (await fs.readFile(path.join(dir, n))).toString('base64'),
          name: `${file.name} @ ${timestamp(i * every)}`,
        })),
      );
      return { images, every, ...(duration === undefined ? {} : { duration }) };
    } catch (err) {
      if (signal.aborted) return { error: 'interrupted' };
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `ffmpeg could not read ${file.name} (${msg.split('\n')[0] ?? msg})` };
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
