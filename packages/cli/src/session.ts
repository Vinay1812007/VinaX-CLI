import {
  createAgentSetup,
  projectDataDir,
  SessionStore,
  type AgentSetup,
  type LoadedSession,
  type Runtime,
  type SessionWriter,
} from '@vinax/core';

export type SessionChoice = { kind: 'new' } | { kind: 'continue' } | { kind: 'resume'; id: string };

export interface OpenedSession {
  setup: AgentSetup;
  writer: SessionWriter;
  /** Present when an earlier session was continued. */
  loaded: LoadedSession | undefined;
  /** Set when `continue` found nothing to continue. */
  note?: string;
}

export function sessionStore(runtime: Runtime): SessionStore {
  return new SessionStore(projectDataDir(runtime.cwd, runtime.env), runtime.cwd);
}

/** Starts a new session or reopens a saved one, wiring the agent to record into it. */
export async function openSession(
  runtime: Runtime,
  choice: SessionChoice,
  opts: { maxTurns?: number | undefined; model?: string | undefined },
): Promise<OpenedSession> {
  const store = sessionStore(runtime);
  let id: string | undefined;
  let note: string | undefined;
  if (choice.kind === 'continue') {
    id = store.latest()?.id;
    if (id === undefined) note = 'No earlier session in this folder; starting a new one.';
  } else if (choice.kind === 'resume') {
    id = choice.id;
  }
  const loaded = id === undefined ? undefined : store.load(id);
  const writer = loaded === undefined ? store.create() : store.open(loaded.id);
  const setup = await createAgentSetup(runtime, {
    recorder: writer,
    ...(opts.maxTurns === undefined ? {} : { maxTurns: opts.maxTurns }),
    ...(opts.model === undefined ? {} : { model: opts.model }),
  });
  if (loaded) {
    setup.agent.restore(loaded);
    setup.checkpoints.load(loaded.checkpoints);
  }
  return { setup, writer, loaded, ...(note === undefined ? {} : { note }) };
}
