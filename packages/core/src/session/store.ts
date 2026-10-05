import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ChatMessage } from '../providers/types.js';

/** One line of a session transcript (`<session-id>.jsonl`). */
export type SessionEntry =
  | { type: 'meta'; id: string; cwd: string; createdAt: string; version: 1 }
  | { type: 'message'; message: ChatMessage }
  | { type: 'turn'; turn: number; messageIndex: number; prompt: string }
  /** Conversation rewound: keep the first `messageCount` messages and `turnsKept` turn marks. */
  | { type: 'truncate'; messageCount: number; turnsKept: number }
  /** Conversation compacted: the message list is replaced wholesale. */
  | { type: 'reset'; messages: ChatMessage[]; keepMarks?: boolean }
  | { type: 'title'; title: string }
  /** The session switched model (older VinaX versions ignore this entry). */
  | { type: 'model'; model: string }
  /** A file's content before `turn` changed it; `blob` is a content hash, `null` = did not exist. */
  | { type: 'checkpoint'; turn: number; file: string; blob: string | null }
  /**
   * A file's content right after VinaX changed it in `turn` (newer versions; older ones ignore
   * it). Rewind compares it with the file on disk to notice edits made outside VinaX.
   */
  | { type: 'checkpoint_result'; turn: number; file: string; blob: string | null }
  | { type: 'checkpoint_drop'; fromTurn: number }
  /** One file is no longer restorable from `fromTurn` on (it was undone on its own). */
  | { type: 'checkpoint_forget'; fromTurn: number; file: string }
  /** Opaque transcript data for the UI to replay on resume. */
  | { type: 'view'; data: unknown };

export interface TurnMark {
  turn: number;
  messageIndex: number;
  prompt: string;
}

/**
 * A line of a transcript that could not be used. `torn` is an incomplete last line (a write cut
 * short by a crash); the others are damage in the middle of the file.
 */
export interface SessionIssue {
  line: number;
  kind: 'torn' | 'malformed' | 'invalid';
  message: string;
}

export interface LoadedSession {
  id: string;
  cwd: string;
  createdAt: string;
  title: string | undefined;
  /** Last model chosen with /model in this session. */
  model: string | undefined;
  messages: ChatMessage[];
  marks: TurnMark[];
  /** turn → file → content before the turn (`null` = file did not exist) */
  checkpoints: Map<number, Map<string, string | null>>;
  /** turn → file → content right after VinaX changed it in that turn (newer sessions only) */
  checkpointResults: Map<number, Map<string, string | null>>;
  views: unknown[];
  /** Lines that were skipped while loading; empty for a healthy file. */
  issues: SessionIssue[];
  file: string;
}

export interface SessionSummary {
  id: string;
  title: string | undefined;
  firstPrompt: string | undefined;
  /** Last model the session used or chose, when recorded. */
  model: string | undefined;
  createdAt: string;
  updatedAt: Date;
  turns: number;
  file: string;
  /** Damaged lines in the middle of the file (a torn last line is not counted). */
  damagedLines: number;
}

export interface SessionRecorder {
  /** Session id and transcript path (given to hooks). */
  readonly id?: string;
  readonly file?: string;
  record(entry: SessionEntry): void;
  /** Stores file content once (content-addressed) and returns its hash. */
  storeBlob(content: string): string;
}

function newId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}

// Entries are validated when read; unknown fields pass through so newer versions can add them.
const imageSchema = z.looseObject({
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
  data: z.string(),
  name: z.string().optional(),
});
const toolCallSchema = z.looseObject({ id: z.string(), name: z.string(), arguments: z.string() });
const messageSchema = z.discriminatedUnion('role', [
  z.looseObject({ role: z.literal('system'), content: z.string() }),
  z.looseObject({
    role: z.literal('user'),
    content: z.string(),
    images: z.array(imageSchema).optional(),
  }),
  z.looseObject({
    role: z.literal('assistant'),
    content: z.string(),
    toolCalls: z.array(toolCallSchema).optional(),
  }),
  z.looseObject({
    role: z.literal('tool'),
    toolCallId: z.string(),
    name: z.string(),
    content: z.string(),
  }),
]);
const count = z.number().int().nonnegative();
const blob = z.string().nullable();
const ENTRY_SCHEMAS: Record<SessionEntry['type'], z.ZodType> = {
  meta: z.looseObject({ id: z.string(), cwd: z.string(), createdAt: z.string() }),
  message: z.looseObject({ message: messageSchema }),
  turn: z.looseObject({ turn: count, messageIndex: count, prompt: z.string() }),
  truncate: z.looseObject({ messageCount: count, turnsKept: count }),
  reset: z.looseObject({ messages: z.array(messageSchema), keepMarks: z.boolean().optional() }),
  title: z.looseObject({ title: z.string() }),
  model: z.looseObject({ model: z.string() }),
  checkpoint: z.looseObject({ turn: count, file: z.string(), blob }),
  checkpoint_result: z.looseObject({ turn: count, file: z.string(), blob }),
  checkpoint_drop: z.looseObject({ fromTurn: count }),
  checkpoint_forget: z.looseObject({ fromTurn: count, file: z.string() }),
  view: z.looseObject({}),
};

function isKnownType(type: unknown): type is SessionEntry['type'] {
  return typeof type === 'string' && Object.hasOwn(ENTRY_SCHEMAS, type);
}

/**
 * Parses a transcript. Entry types this version does not know (written by a newer VinaX) are
 * skipped quietly; unreadable or invalid lines are skipped and reported.
 */
export function parseSession(text: string): { entries: SessionEntry[]; issues: SessionIssue[] } {
  const entries: SessionEntry[] = [];
  const issues: SessionIssue[] = [];
  const lines = text.split('\n');
  for (const [i, line] of lines.entries()) {
    if (line.trim() === '') continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      // only a last line without its newline can be a write that was cut short
      const torn = i === lines.length - 1 && !text.endsWith('\n');
      issues.push({
        line: i + 1,
        kind: torn ? 'torn' : 'malformed',
        message: torn ? 'incomplete last line (a write was interrupted)' : 'not valid JSON',
      });
      continue;
    }
    const type = (raw as { type?: unknown } | null)?.type;
    if (typeof raw !== 'object' || raw === null || typeof type !== 'string') {
      issues.push({ line: i + 1, kind: 'invalid', message: 'not a session entry' });
      continue;
    }
    if (!isKnownType(type)) continue;
    const parsed = ENTRY_SCHEMAS[type].safeParse(raw);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      issues.push({
        line: i + 1,
        kind: 'invalid',
        message: `bad "${type}" entry${first === undefined ? '' : ` (${first.path.join('.') || 'value'}: ${first.message})`}`,
      });
      continue;
    }
    entries.push(raw as SessionEntry);
  }
  return { entries, issues };
}

/** Appends entries synchronously, so a crash never loses a completed step. */
export class SessionWriter implements SessionRecorder {
  constructor(
    readonly id: string,
    readonly file: string,
    private readonly blobDir: string,
  ) {}

  record(entry: SessionEntry): void {
    fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }

  storeBlob(content: string): string {
    const hash = createHash('sha256').update(content).digest('hex');
    const file = path.join(this.blobDir, hash);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(this.blobDir, { recursive: true });
      fs.writeFileSync(file, content, { mode: 0o600 });
    }
    return hash;
  }
}

/** What `list()` remembers about a transcript, valid while its size and mtime are unchanged. */
interface IndexEntry {
  size: number;
  mtimeMs: number;
  /** `undefined`: the file has no header or no prompts and is not listed. */
  summary: Omit<SessionSummary, 'updatedAt' | 'file'> | undefined;
}

const INDEX_FILE = '.index.json';
const INDEX_VERSION = 1;

/**
 * Session transcripts for one project in `~/.vinax/projects/<encoded-cwd>/sessions/`, with
 * checkpoint file contents stored once each in `…/blobs/`.
 */
export class SessionStore {
  private readonly sessionsDir: string;
  private readonly blobDir: string;

  constructor(
    projectDir: string,
    private readonly cwd: string,
  ) {
    this.sessionsDir = path.join(projectDir, 'sessions');
    this.blobDir = path.join(projectDir, 'blobs');
  }

  private fileFor(id: string): string {
    return path.join(this.sessionsDir, `${id}.jsonl`);
  }

  create(now: Date = new Date()): SessionWriter {
    fs.mkdirSync(this.sessionsDir, { recursive: true, mode: 0o700 });
    const id = newId(now);
    const writer = new SessionWriter(id, this.fileFor(id), this.blobDir);
    writer.record({ type: 'meta', id, cwd: this.cwd, createdAt: now.toISOString(), version: 1 });
    return writer;
  }

  /**
   * Continues writing to an existing session file. An unfinished last line (VinaX was killed
   * mid-write) is moved to `<id>.jsonl.torn` first, so new entries do not get glued onto it.
   */
  open(id: string): SessionWriter {
    const file = this.fileFor(id);
    this.repairTail(file);
    return new SessionWriter(id, file, this.blobDir);
  }

  /** Returns the set-aside fragment's path when the file ended in an unfinished line. */
  private repairTail(file: string): string | undefined {
    let fd: number;
    try {
      fd = fs.openSync(file, 'r+');
    } catch {
      return undefined;
    }
    try {
      const size = fs.fstatSync(fd).size;
      if (size === 0) return undefined;
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      if (last[0] === 0x0a) return undefined;
      // find the start of the unfinished line (scan back in blocks)
      let start = 0;
      const block = Buffer.alloc(64 * 1024);
      for (let end = size; end > 0;) {
        const from = Math.max(0, end - block.length);
        const n = fs.readSync(fd, block, 0, end - from, from);
        const nl = block.subarray(0, n).lastIndexOf(0x0a);
        if (nl !== -1) {
          start = from + nl + 1;
          break;
        }
        end = from;
      }
      const fragment = Buffer.alloc(size - start);
      fs.readSync(fd, fragment, 0, fragment.length, start);
      // a complete entry that only lacks its newline is kept as it is
      try {
        JSON.parse(fragment.toString('utf8'));
        fs.writeSync(fd, '\n', size);
        return undefined;
      } catch {
        // unfinished: set it aside
      }
      const aside = `${file}.torn`;
      fs.appendFileSync(aside, Buffer.concat([fragment, Buffer.from('\n')]), { mode: 0o600 });
      fs.ftruncateSync(fd, start);
      return aside;
    } finally {
      fs.closeSync(fd);
    }
  }

  private readIndex(): Map<string, IndexEntry> {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.sessionsDir, INDEX_FILE), 'utf8')) as {
        version?: unknown;
        files?: Record<string, IndexEntry>;
      };
      if (raw.version !== INDEX_VERSION || typeof raw.files !== 'object') return new Map();
      return new Map(Object.entries(raw.files));
    } catch {
      return new Map();
    }
  }

  private writeIndex(index: Map<string, IndexEntry>): void {
    const file = path.join(this.sessionsDir, INDEX_FILE);
    const tmp = `${file}.${String(process.pid)}.tmp`;
    try {
      fs.writeFileSync(
        tmp,
        JSON.stringify({ version: INDEX_VERSION, files: Object.fromEntries(index) }),
        { mode: 0o600 },
      );
      fs.renameSync(tmp, file);
    } catch {
      // the index is only a cache
      fs.rmSync(tmp, { force: true });
    }
  }

  private summarize(text: string): IndexEntry['summary'] {
    const { entries, issues } = parseSession(text);
    let meta: Extract<SessionEntry, { type: 'meta' }> | undefined;
    let title: string | undefined;
    let model: string | undefined;
    let firstPrompt: string | undefined;
    let turns = 0;
    for (const e of entries) {
      if (e.type === 'meta') meta ??= e;
      else if (e.type === 'title') title = e.title;
      else if (e.type === 'model') model = e.model;
      else if (e.type === 'turn') {
        turns++;
        firstPrompt ??= e.prompt;
      }
    }
    if (!meta || turns === 0) return undefined;
    return {
      id: meta.id,
      title,
      firstPrompt,
      model,
      createdAt: meta.createdAt,
      turns,
      damagedLines: issues.filter((i) => i.kind !== 'torn').length,
    };
  }

  /**
   * Sessions with at least one prompt, most recently used first. Summaries are cached in
   * `sessions/.index.json` and reused while a transcript's size and mtime are unchanged, so only
   * the sessions that changed are read again.
   */
  list(): SessionSummary[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.sessionsDir).filter((n) => n.endsWith('.jsonl'));
    } catch {
      return [];
    }
    const cached = this.readIndex();
    const next = new Map<string, IndexEntry>();
    let changed = cached.size !== names.length;
    const out: SessionSummary[] = [];
    for (const name of names) {
      const file = path.join(this.sessionsDir, name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        changed = true;
        continue;
      }
      let entry = cached.get(name);
      if (entry?.size !== stat.size || entry.mtimeMs !== stat.mtimeMs) {
        let text: string;
        try {
          text = fs.readFileSync(file, 'utf8');
        } catch {
          changed = true;
          continue;
        }
        entry = { size: stat.size, mtimeMs: stat.mtimeMs, summary: this.summarize(text) };
        changed = true;
      }
      next.set(name, entry);
      if (entry.summary) out.push({ ...entry.summary, updatedAt: stat.mtime, file });
    }
    if (changed) this.writeIndex(next);
    return out.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  latest(): SessionSummary | undefined {
    return this.list()[0];
  }

  load(id: string): LoadedSession {
    const file = this.fileFor(id);
    const { entries, issues } = parseSession(fs.readFileSync(file, 'utf8'));
    const meta = entries.find((e) => e.type === 'meta');
    if (!meta) {
      const damaged = issues.find((i) => i.line === 1);
      throw new Error(
        `Session ${id} has no readable header${damaged === undefined ? '' : ` (line 1: ${damaged.message})`}. The file is unchanged: ${file}`,
      );
    }
    const session: LoadedSession = {
      id: meta.id,
      cwd: meta.cwd,
      createdAt: meta.createdAt,
      title: undefined,
      model: undefined,
      messages: [],
      marks: [],
      checkpoints: new Map(),
      checkpointResults: new Map(),
      views: [],
      issues,
      file,
    };
    const forget = (map: Map<number, Map<string, string | null>>, from: number, f: string) => {
      for (const [t, files] of map) if (t >= from) files.delete(f);
    };
    for (const e of entries) {
      switch (e.type) {
        case 'message':
          session.messages.push(e.message);
          break;
        case 'turn':
          session.marks.push({ turn: e.turn, messageIndex: e.messageIndex, prompt: e.prompt });
          break;
        case 'truncate':
          session.messages.length = Math.min(session.messages.length, e.messageCount);
          session.marks.length = Math.min(session.marks.length, e.turnsKept);
          break;
        case 'reset':
          session.messages = [...e.messages];
          if (e.keepMarks !== true) session.marks = [];
          break;
        case 'title':
          session.title = e.title;
          break;
        case 'model':
          session.model = e.model;
          break;
        case 'checkpoint': {
          const files = session.checkpoints.get(e.turn) ?? new Map<string, string | null>();
          // a missing blob must not turn into "file did not exist" (that would delete it on rewind)
          const content = e.blob === null ? null : this.readBlob(e.blob);
          if (!files.has(e.file) && content !== undefined) files.set(e.file, content);
          session.checkpoints.set(e.turn, files);
          break;
        }
        case 'checkpoint_result': {
          const files = session.checkpointResults.get(e.turn) ?? new Map<string, string | null>();
          const content = e.blob === null ? null : this.readBlob(e.blob);
          // a missing blob leaves the result unknown, so rewind asks before touching the file
          if (content === undefined) files.delete(e.file);
          else files.set(e.file, content);
          session.checkpointResults.set(e.turn, files);
          break;
        }
        case 'checkpoint_drop':
          for (const map of [session.checkpoints, session.checkpointResults])
            for (const t of [...map.keys()]) if (t >= e.fromTurn) map.delete(t);
          break;
        case 'checkpoint_forget':
          forget(session.checkpoints, e.fromTurn, e.file);
          forget(session.checkpointResults, e.fromTurn, e.file);
          break;
        case 'view':
          session.views.push(e.data);
          break;
        case 'meta':
          break;
      }
    }
    return session;
  }

  private readBlob(hash: string): string | undefined {
    try {
      return fs.readFileSync(path.join(this.blobDir, hash), 'utf8');
    } catch {
      return undefined;
    }
  }
}

/** One line for the user about a session file's damage, or undefined when it is healthy. */
export function describeSessionIssues(
  session: Pick<LoadedSession, 'issues' | 'file'>,
): { level: 'info' | 'warning'; text: string } | undefined {
  const damaged = session.issues.filter((i) => i.kind !== 'torn');
  const torn = session.issues.some((i) => i.kind === 'torn');
  if (damaged.length === 0 && !torn) return undefined;
  if (damaged.length === 0) {
    return {
      level: 'info',
      text: `The last write to this session was interrupted (VinaX probably exited mid-step); that incomplete entry was set aside in ${session.file}.torn and everything before it was restored.`,
    };
  }
  const lines = damaged
    .slice(0, 5)
    .map((i) => `${String(i.line)} (${i.message})`)
    .join(', ');
  const more = damaged.length > 5 ? ` and ${String(damaged.length - 5)} more` : '';
  return {
    level: 'warning',
    text: `${String(damaged.length)} damaged line${damaged.length === 1 ? ' was' : 's were'} skipped while loading this session: line ${lines}${more}. The conversation may have gaps there. The file was not modified; inspect or back it up at ${session.file}.`,
  };
}
