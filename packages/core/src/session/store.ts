import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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
  /** A file's content before `turn` changed it; `blob` is a content hash, `null` = did not exist. */
  | { type: 'checkpoint'; turn: number; file: string; blob: string | null }
  | { type: 'checkpoint_drop'; fromTurn: number }
  /** Opaque transcript data for the UI to replay on resume. */
  | { type: 'view'; data: unknown };

export interface TurnMark {
  turn: number;
  messageIndex: number;
  prompt: string;
}

export interface LoadedSession {
  id: string;
  cwd: string;
  createdAt: string;
  title: string | undefined;
  messages: ChatMessage[];
  marks: TurnMark[];
  /** turn → file → content before the turn (`null` = file did not exist) */
  checkpoints: Map<number, Map<string, string | null>>;
  views: unknown[];
}

export interface SessionSummary {
  id: string;
  title: string | undefined;
  firstPrompt: string | undefined;
  createdAt: string;
  updatedAt: Date;
  turns: number;
  file: string;
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

function parseLines(text: string): SessionEntry[] {
  const out: SessionEntry[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line) as SessionEntry);
    } catch {
      // a torn last line after a crash: skip it
    }
  }
  return out;
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

  create(now: Date = new Date()): SessionWriter {
    fs.mkdirSync(this.sessionsDir, { recursive: true, mode: 0o700 });
    const id = newId(now);
    const writer = new SessionWriter(id, path.join(this.sessionsDir, `${id}.jsonl`), this.blobDir);
    writer.record({ type: 'meta', id, cwd: this.cwd, createdAt: now.toISOString(), version: 1 });
    return writer;
  }

  /** Continues writing to an existing session file. */
  open(id: string): SessionWriter {
    return new SessionWriter(id, path.join(this.sessionsDir, `${id}.jsonl`), this.blobDir);
  }

  /** Sessions with at least one prompt, most recently used first. */
  list(): SessionSummary[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.sessionsDir).filter((n) => n.endsWith('.jsonl'));
    } catch {
      return [];
    }
    const out: SessionSummary[] = [];
    for (const name of names) {
      const file = path.join(this.sessionsDir, name);
      let text: string;
      let stat: fs.Stats;
      try {
        text = fs.readFileSync(file, 'utf8');
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      const entries = parseLines(text);
      const meta = entries.find((e) => e.type === 'meta');
      const turns = entries.filter((e) => e.type === 'turn');
      if (!meta || turns.length === 0) continue;
      const titles = entries.filter((e) => e.type === 'title');
      out.push({
        id: meta.id,
        title: titles.at(-1)?.title,
        firstPrompt: turns[0]?.prompt,
        createdAt: meta.createdAt,
        updatedAt: stat.mtime,
        turns: turns.length,
        file,
      });
    }
    return out.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  latest(): SessionSummary | undefined {
    return this.list()[0];
  }

  load(id: string): LoadedSession {
    const entries = parseLines(fs.readFileSync(path.join(this.sessionsDir, `${id}.jsonl`), 'utf8'));
    const meta = entries.find((e) => e.type === 'meta');
    if (!meta) throw new Error(`Session ${id} has no header`);
    const session: LoadedSession = {
      id: meta.id,
      cwd: meta.cwd,
      createdAt: meta.createdAt,
      title: undefined,
      messages: [],
      marks: [],
      checkpoints: new Map(),
      views: [],
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
        case 'checkpoint': {
          const files = session.checkpoints.get(e.turn) ?? new Map<string, string | null>();
          // a missing blob must not turn into "file did not exist" (that would delete it on rewind)
          const content = e.blob === null ? null : this.readBlob(e.blob);
          if (!files.has(e.file) && content !== undefined) files.set(e.file, content);
          session.checkpoints.set(e.turn, files);
          break;
        }
        case 'checkpoint_drop':
          for (const t of [...session.checkpoints.keys()])
            if (t >= e.fromTurn) session.checkpoints.delete(t);
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
