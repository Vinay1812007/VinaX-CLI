import path from 'node:path';
import type { PermissionMode } from '../config/schema.js';
import { HookRunner, type HookResult } from '../hooks/runner.js';
import { loadMcpConfig, type McpServerEntry } from '../mcp/config.js';
import { McpManager } from '../mcp/manager.js';
import { ProjectMemory } from '../memory/memory.js';
import { PermissionEngine } from '../permissions/engine.js';
import { parseModelRef, type ModelRef } from '../providers/types.js';
import type { Runtime } from '../runtime.js';
import type { SessionRecorder } from '../session/store.js';
import { AppStateStore } from '../state/app-state.js';
import { displayPath, resolvePath } from '../tools/paths.js';
import { ReadTracker } from '../tools/read-tracker.js';
import { createToolset } from '../tools/registry.js';
import { detectShell, ShellSession } from '../tools/shell.js';
import { TodoStore } from '../tools/todo.js';
import type { AnyTool } from '../tools/types.js';
import { createWebFetchTool } from '../tools/webfetch.js';
import { Agent } from './agent.js';
import { CheckpointStore } from './checkpoints.js';
import {
  createTaskTool,
  loadSubagents,
  type SubagentDef,
  type SubagentRunner,
} from './subagents.js';
import { buildSystemPrompt, readGitInfo } from './system-prompt.js';

/** Model calls a sub-agent may make for one Task. */
const SUBAGENT_MAX_TURNS = 30;

export interface AgentSetupOptions {
  maxTurns?: number;
  /** Head of the fallback chain (e.g. `--model`). */
  model?: string;
  /** Persists the conversation and checkpoints. */
  recorder?: SessionRecorder;
  /** Start MCP servers (default true). */
  mcp?: boolean;
  /** VinaX version, reported to MCP servers. */
  version?: string;
  now?: Date;
}

export interface AgentSetup {
  agent: Agent;
  shell: ShellSession;
  todos: TodoStore;
  permissions: PermissionEngine;
  checkpoints: CheckpointStore;
  /** Live list: MCP tools are added when a server is approved during the session. */
  tools: readonly AnyTool[];
  workspace: readonly string[];
  memory: ProjectMemory;
  /** Files the model has seen (for Edit/Write freshness checks and `@` attachments). */
  reads: ReadTracker;
  /** Conversation budget in tokens (compaction starts at 85%). */
  contextLimit: () => number;
  hooks: HookRunner;
  mcp: McpManager;
  subagents: readonly SubagentDef[];
  /** Problems loading MCP config or sub-agent files. */
  warnings: string[];
  /** Runs SessionStart hooks; their output is added to the conversation as context. */
  sessionStart: (source: 'startup' | 'resume' | 'clear') => Promise<HookResult>;
  /** Approves a project MCP server for this folder and connects it now. */
  approveMcpServer: (name: string) => Promise<void>;
  /** Stops background jobs and MCP servers. */
  close: () => Promise<void>;
}

/** Wires tools, permissions, hooks, MCP, sub-agents, checkpoints and the system prompt. */
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
  const warnings: string[] = [];
  let currentMode: PermissionMode = settings.permissions.defaultMode;

  const hooks = new HookRunner(settings.hooks, {
    cwd,
    env,
    shell: shellInfo,
    disabled: settings.disableAllHooks,
    base: () => ({
      session_id: opts.recorder?.id,
      transcript_path: opts.recorder?.file,
      permission_mode: currentMode,
    }),
  });

  const tools: AnyTool[] = [
    ...createToolset({ shell: shellInfo, todos }),
    createWebFetchTool(runtime.router),
  ];
  const context = { cwd, workspace, shell, reads };
  const basePrompt = (mode: PermissionMode, toolInstructions?: string): string => {
    currentMode = mode;
    return buildSystemPrompt(
      { cwd, shell: shellInfo.label, date, git, memory: memory.text() },
      mode,
      toolInstructions,
    );
  };
  const supportsTools = (ref: ModelRef): boolean | undefined =>
    runtime.models.get(ref.provider)?.find((m) => m.id === ref.model)?.supportsTools;
  const onPathTouched = (file: string): string | undefined => {
    const found = memory.discover(file);
    if (found.length === 0) return undefined;
    return found
      .map(
        (f) =>
          `<folder-instructions path="${displayPath(f.path, cwd)}">\nThese instructions apply to work in this folder:\n${f.content.trim()}\n</folder-instructions>`,
      )
      .join('\n\n');
  };

  // Sub-agents run a fresh Agent with their own context but the same tools, permissions and host.
  const { agents: subagents, errors: agentErrors } = await loadSubagents(cwd, env);
  warnings.push(...agentErrors);
  const runSubagent: SubagentRunner = async (def, prompt, ctx) => {
    const allowed = tools.filter(
      (t) =>
        t.name !== 'Task' &&
        (def.tools === undefined ||
          def.tools.some(
            (p) => p === t.name || (p.endsWith('*') && t.name.startsWith(p.slice(0, -1))),
          )),
    );
    const model = def.model ?? agent.model;
    const child = new Agent({
      router: runtime.router,
      tools: allowed,
      permissions,
      checkpoints,
      context,
      systemPrompt: (mode, instr) =>
        `${basePrompt(mode, instr)}\n\n# Your role: ${def.name} sub-agent\n${def.prompt}\nYou were given one task by the main VinaX agent. Work on your own, then reply with a concise report of what you found or changed (with file paths). The report goes back to the main agent, not straight to the user.`,
      supportsTools,
      maxTurns: SUBAGENT_MAX_TURNS,
      nested: true,
      onPathTouched,
      hooks,
      ...(model === undefined ? {} : { model }),
    });
    let calls = 0;
    const host = ctx.host ?? {
      mode: () => 'default' as const,
      askPermission: () =>
        Promise.resolve({ kind: 'unavailable' as const, message: 'No one can approve this.' }),
    };
    const out = await child.run(prompt, {
      signal: ctx.signal,
      host,
      onEvent: (ev) => {
        if (ev.type === 'tool_call') {
          calls++;
          ctx.onProgress?.(`▸ ${ev.name} ${ev.label}\n`);
        } else if (ev.type === 'tool_result') {
          ctx.onProgress?.(`  └ ${ev.summary}\n`);
        }
      },
    });
    return { text: out.text, toolCalls: calls, ok: out.status === 'done' };
  };
  tools.push(createTaskTool(subagents, runSubagent));

  const mcp = new McpManager({ cwd, env, version: opts.version ?? '0.0.0' });
  if (opts.mcp !== false) {
    const { servers, errors } = await loadMcpConfig(cwd, env);
    warnings.push(...errors);
    const state = new AppStateStore(env);
    await mcp.start(servers, (entry: McpServerEntry) =>
      entry.scope === 'user' ? Promise.resolve(true) : state.isMcpApproved(cwd, entry.name),
    );
    tools.push(...mcp.tools());
    for (const s of mcp.servers) {
      if (s.status === 'failed')
        warnings.push(`MCP server "${s.name}" failed to start: ${s.error ?? 'unknown error'}`);
      if (s.status === 'needs-approval') {
        warnings.push(
          `Project MCP server "${s.name}" is not approved yet. Use /mcp to review and allow it.`,
        );
      }
    }
  }

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
    context,
    systemPrompt: basePrompt,
    supportsTools,
    onPathTouched,
    hooks,
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
    hooks,
    mcp,
    subagents,
    warnings,
    async sessionStart(source) {
      const r = await hooks.run('SessionStart', { source });
      if (r.context.length > 0) {
        agent.addContext(
          `<session-start-context>\n${r.context.join('\n')}\n</session-start-context>`,
        );
      }
      return r;
    },
    async approveMcpServer(name) {
      const server = mcp.servers.find((s) => s.name === name);
      if (!server) throw new Error(`No MCP server named ${name}`);
      await new AppStateStore(env).approveMcp(cwd, name);
      await mcp.connect(server);
      for (const t of server.tools) if (!tools.some((x) => x.name === t.name)) tools.push(t);
      if (server.status === 'failed') throw new Error(server.error ?? 'failed to connect');
    },
    async close() {
      shell.killAll();
      await mcp.close();
    },
  };
}
