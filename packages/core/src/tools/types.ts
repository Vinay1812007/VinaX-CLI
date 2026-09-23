import type { z } from 'zod';
import type { AgentHost } from '../agent/agent.js';
import type { PlanDecision } from './plan-tool.js';
import type { ReadTracker } from './read-tracker.js';
import type { ShellSession } from './shell.js';
import type { TodoItem } from './todo.js';

/** How a tool is treated by the permission engine. */
export type ToolKind = 'read' | 'edit' | 'execute' | 'network' | 'meta';

export interface DiffLine {
  kind: 'add' | 'remove' | 'context';
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface DiffHunk {
  lines: DiffLine[];
}

export type ToolDisplay =
  | {
      kind: 'diff';
      path: string;
      created: boolean;
      added: number;
      removed: number;
      hunks: DiffHunk[];
    }
  | { kind: 'todos'; todos: TodoItem[] }
  | { kind: 'plan'; plan: string };

export interface ToolOutput {
  ok: boolean;
  /** Text returned to the model. */
  content: string;
  /** One-line summary for the transcript, e.g. "Read 120 lines". */
  summary: string;
  display?: ToolDisplay;
}

/** What a permission rule is matched against. */
export interface PermissionTarget {
  path?: string;
  command?: string;
  domain?: string;
}

export interface ToolContext {
  /** Project root: the folder VinaX was started in. */
  cwd: string;
  /** Folders tools may touch without extra approval: the project root plus `--add-dir`s. */
  workspace: readonly string[];
  shell: ShellSession;
  reads: ReadTracker;
  signal: AbortSignal;
  /** Live output from long-running tools (Bash). */
  onProgress?: (chunk: string) => void;
  /** Asks the user to approve a plan; absent when nobody can answer (headless runs). */
  approvePlan?: (plan: string) => Promise<PlanDecision>;
  /** The session's host, so a sub-agent (Task) can ask for approvals the same way. */
  host?: AgentHost;
}

export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string;
  /** Written for the model: when and how to use the tool. */
  description: string;
  input: S;
  /** Parameters as JSON Schema when the tool brings its own (MCP); otherwise derived from `input`. */
  jsonSchema?: Record<string, unknown>;
  kind: ToolKind;
  /** Read-only tools may run in parallel and are allowed in plan mode. */
  readOnly: boolean;
  /** One short argument shown in the transcript, e.g. the file path or command. */
  label(input: z.infer<S>): string;
  target(input: z.infer<S>, ctx: ToolContext): PermissionTarget;
  /** Files this call may change; they are checkpointed before it runs. */
  affectedPaths?(input: z.infer<S>, ctx: ToolContext): string[];
  /** Preview shown in the approval prompt (e.g. the diff an edit would make). */
  preview?(input: z.infer<S>, ctx: ToolContext): Promise<ToolDisplay | undefined>;
  run(input: z.infer<S>, ctx: ToolContext): Promise<ToolOutput>;
}

/** Erases the input type so heterogeneous tools can share one list. */
export type AnyTool = Tool;

export function defineTool<S extends z.ZodType>(tool: Tool<S>): AnyTool {
  return tool;
}

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}
