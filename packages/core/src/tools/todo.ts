import { z } from 'zod';
import { defineTool } from './types.js';

export const todoItemSchema = z.object({
  content: z.string().min(1).describe('The task, in imperative form ("Run the tests")'),
  status: z.enum(['pending', 'in_progress', 'completed']),
  activeForm: z
    .string()
    .optional()
    .describe('Present-tense form shown while working ("Running the tests")'),
});
export type TodoItem = z.infer<typeof todoItemSchema>;

/** The session's task list, replaced wholesale by each TodoWrite call. */
export class TodoStore {
  private items: TodoItem[] = [];
  private readonly listeners = new Set<(todos: TodoItem[]) => void>();

  get todos(): TodoItem[] {
    return this.items;
  }

  set(todos: TodoItem[]): void {
    this.items = todos;
    for (const l of this.listeners) l(todos);
  }

  subscribe(listener: (todos: TodoItem[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export function createTodoTool(store: TodoStore) {
  return defineTool({
    name: 'TodoWrite',
    description:
      'Maintain a task list for work with three or more steps. Send the complete list every time. Keep exactly one task in_progress while working, and mark tasks completed as soon as they are done.',
    input: z.object({ todos: z.array(todoItemSchema) }),
    kind: 'meta',
    readOnly: true,
    label: (i) => `${String(i.todos.length)} tasks`,
    target: () => ({}),
    run(i) {
      store.set(i.todos);
      const done = i.todos.filter((t) => t.status === 'completed').length;
      return Promise.resolve({
        ok: true,
        content: 'Task list updated. Continue with the current task.',
        summary: `${String(done)}/${String(i.todos.length)} done`,
        display: { kind: 'todos', todos: i.todos },
      });
    },
  });
}
