import { z } from 'zod';
import type { PermissionMode } from '../config/schema.js';
import { defineTool } from './types.js';

export type PlanDecision =
  { approved: true; mode: Exclude<PermissionMode, 'plan'> } | { approved: false; feedback: string };

export const exitPlanTool = defineTool({
  name: 'ExitPlanMode',
  description:
    'In plan mode, present your finished plan to the user for approval. Use it only after researching, and only for tasks that change code. Write the plan as concise Markdown steps.',
  input: z.object({ plan: z.string().min(1).describe('The plan, in Markdown') }),
  kind: 'meta',
  readOnly: true,
  label: () => 'present plan',
  target: () => ({}),
  async run(i, ctx) {
    const approver = ctx.approvePlan;
    if (!approver) {
      return {
        ok: false,
        content:
          'Plan approval needs an interactive session. Describe the plan in your reply instead.',
        summary: 'No one to approve the plan',
        display: { kind: 'plan', plan: i.plan },
      };
    }
    const decision = await approver(i.plan);
    if (decision.approved) {
      return {
        ok: true,
        content: 'The user approved the plan. Carry it out now, step by step.',
        summary:
          decision.mode === 'acceptEdits'
            ? 'Plan approved · auto-accepting edits'
            : 'Plan approved',
        display: { kind: 'plan', plan: i.plan },
      };
    }
    return {
      ok: false,
      content: `The user wants changes to the plan. Stay in plan mode and revise it. Feedback: ${decision.feedback || '(none given)'}`,
      summary: 'Plan not approved',
      display: { kind: 'plan', plan: i.plan },
    };
  },
});
