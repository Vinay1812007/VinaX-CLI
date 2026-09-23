import path from 'node:path';
import { ProjectMemory } from '../memory/memory.js';
import { PermissionEngine } from '../permissions/engine.js';
import { parseModelRef } from '../providers/types.js';
import type { SessionRecorder } from '../session/store.js';
import { displayPath } from '../tools/paths.js';
import type { Runtime } from '../runtime.js';
import { resolvePath } from '../tools/paths.js';
import { ReadTracker } from '../tools/read-tracker.js';
import { createToolset } from '../tools/registry.js';
import { detectShell, ShellSession } from '../tools/shell.js';
import { TodoStore } from '../tools/todo.js';
import type { AnyTool } from '../tools/types.js';
import { Agent } from './agent.js';
import { CheckpointStore } from './checkpoints.js';
import { buildSystemPrompt, readGitInfo } from './system-prompt.js';

export interface AgentSetupOptions {
  maxTurns?: number;
  /** Head of the fallback chain (e.g. `--model`). */
  model?: string;
  /** Persists the conversation and checkpoints. */
  recorder?: SessionRecorder;
  now?: Date;
}

export interface AgentSetup {
  agent: Agent;
  shell: ShellSession;
  todos: TodoStore;
  permissions: PermissionEngine;
  checkpoints: CheckpointStore;
  tools: readonly AnyTool[];
  workspace: readonly string[];
  memory: ProjectMemory;
  /** Files the model has seen (for Edit/Write freshness checks and `@` attachments). */
  reads: ReadTracker;
  /** Conversation budget in tokens (compaction starts at 85%). */
  contextLimit: () => number;
}

/** Wires the tools, permission engine, checkpoints and system prompt for one session. */
export async function createAgentSetup(
  runtime: Runtime,
  opts: AgentSetupOptions = {},
): Promise<AgentSetup> {
  const { cwd, env } = runtime;
  const settings = runtime.settings.resolved;
  const workspace = [
    cwd,
    ...settings.permissions.additionalDirectories.map((d) => resolvePath(d, cwd)),
  ].map((d) => path.resolve(d));
  const shellInfo = detectShell(env);
  const shell = new ShellSession(shellInfo, cwd, env);
  const todos = new TodoStore();
  const tools = createToolset({ shell: shellInfo, todos });
  const permissions = new PermissionEngine({
    rules: settings.permissions,
    cwd,
    workspace,
    shellCwd: () => shell.cwd,
  });
  const checkpoints = new CheckpointStore(opts.recorder);
  const memory = ProjectMemory.load(cwd, env);
  const reads = new ReadTracker();
  const git = await readGitInfo(cwd);
  const date = (opts.now ?? new Date()).toISOString().slice(0, 10);
  // The smaller of the configured budget and the head model's own window.
  const contextLimit = (): number => {
    const head = parseModelRef(agent.model ?? settings.model);
    const window = runtime.models
      .get(head.provider)
      ?.find((m) => m.id === head.model)?.contextWindow;
    return Math.min(settings.context.maxTokens, window ?? Number.POSITIVE_INFINITY);
  };
  const agent: Agent = new Agent({
    router: runtime.router,
    tools,
    permissions,
    checkpoints,
    context: { cwd, workspace, shell, reads },
    systemPrompt: (mode, toolInstructions) =>
      buildSystemPrompt(
        {
          cwd,
          shell: shellInfo.label,
          date,
          git,
          memory: memory.text(),
        },
        mode,
        toolInstructions,
      ),
    supportsTools: (ref) =>
      runtime.models.get(ref.provider)?.find((m) => m.id === ref.model)?.supportsTools,
    onPathTouched: (file) => {
      const found = memory.discover(file);
      if (found.length === 0) return undefined;
      return found
        .map(
          (f) =>
            `<folder-instructions path="${displayPath(f.path, cwd)}">\nThese instructions apply to work in this folder:\n${f.content.trim()}\n</folder-instructions>`,
        )
        .join('\n\n');
    },
    ...(settings.context.autoCompact ? { contextLimit } : {}),
    ...(opts.recorder === undefined ? {} : { recorder: opts.recorder }),
    ...(opts.maxTurns === undefined ? {} : { maxTurns: opts.maxTurns }),
    ...(opts.model === undefined ? {} : { model: opts.model }),
  });
  return {
    agent,
    shell,
    todos,
    permissions,
    checkpoints,
    tools,
    workspace,
    memory,
    reads,
    contextLimit,
  };
}
