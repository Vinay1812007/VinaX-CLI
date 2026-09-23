import path from 'node:path';
import { PermissionEngine } from '../permissions/engine.js';
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
  /** Project instructions for the system prompt. */
  memory?: string;
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
  const checkpoints = new CheckpointStore();
  const git = await readGitInfo(cwd);
  const date = (opts.now ?? new Date()).toISOString().slice(0, 10);
  const agent = new Agent({
    router: runtime.router,
    tools,
    permissions,
    checkpoints,
    context: { cwd, workspace, shell, reads: new ReadTracker() },
    systemPrompt: (mode, toolInstructions) =>
      buildSystemPrompt(
        {
          cwd,
          shell: shellInfo.label,
          date,
          git,
          ...(opts.memory === undefined ? {} : { memory: opts.memory }),
        },
        mode,
        toolInstructions,
      ),
    supportsTools: (ref) =>
      runtime.models.get(ref.provider)?.find((m) => m.id === ref.model)?.supportsTools,
    ...(opts.maxTurns === undefined ? {} : { maxTurns: opts.maxTurns }),
    ...(opts.model === undefined ? {} : { model: opts.model }),
  });
  return { agent, shell, todos, permissions, checkpoints, tools, workspace };
}
