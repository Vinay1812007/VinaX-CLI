import { z } from 'zod';
import type { ToolSpec } from '../providers/types.js';
import { createBashTools } from './bash-tool.js';
import { editTool, multiEditTool, readTool, writeTool } from './file-tools.js';
import { exitPlanTool } from './plan-tool.js';
import { globTool, grepTool, lsTool } from './search-tools.js';
import type { ShellInfo } from './shell.js';
import { createTodoTool, type TodoStore } from './todo.js';
import type { AnyTool } from './types.js';

export function createToolset(opts: { shell: ShellInfo; todos: TodoStore }): AnyTool[] {
  return [
    readTool,
    globTool,
    grepTool,
    lsTool,
    editTool,
    multiEditTool,
    writeTool,
    ...createBashTools(opts.shell),
    createTodoTool(opts.todos),
    exitPlanTool,
  ];
}

/** Drops JSON Schema noise that costs tokens without helping the model. */
function tidy(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(tidy);
  if (typeof node !== 'object' || node === null) return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === '$schema') continue;
    if (
      (k === 'maximum' || k === 'minimum') &&
      typeof v === 'number' &&
      Math.abs(v) >= Number.MAX_SAFE_INTEGER
    )
      continue;
    out[k] = tidy(v);
  }
  return out;
}

export function toolSpec(tool: AnyTool): ToolSpec {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tidy(z.toJSONSchema(tool.input, { io: 'input' })) as Record<string, unknown>,
  };
}

/** "Invalid arguments" feedback the model can act on. */
export function describeInvalidArgs(tool: string, error: z.ZodError): string {
  return `Invalid arguments for ${tool}:\n${z.prettifyError(error)}\nFix the arguments and call ${tool} again.`;
}
