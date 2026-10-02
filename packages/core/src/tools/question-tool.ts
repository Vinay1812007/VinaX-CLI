import { z } from 'zod';
import { defineTool } from './types.js';

const questionSchema = z.object({
  question: z.string().trim().min(1).max(1000),
  options: z.array(z.string().trim().min(1).max(200)).max(6).default([]),
});

export type UserQuestion = z.infer<typeof questionSchema>;
export type UserAnswer = { answer: string } | { cancelled: true };

export const askUserTool = defineTool({
  name: 'AskUserQuestion',
  description:
    'Ask the user one clarification question and wait for their answer. Provide up to six short choices, or an empty options list for free text. The user can always type their own answer. Use only when missing information affects the task; do not use this for tool permissions or plan approval.',
  input: questionSchema,
  kind: 'meta',
  readOnly: true,
  label: (input) => input.question,
  target: () => ({}),
  async run(input, ctx) {
    if (!ctx.host?.askQuestion)
      return {
        ok: false,
        content: `Interactive questions are unavailable. Ask this in your reply and wait for the next user message: ${input.question}`,
        summary: 'Needs user input',
      };
    const result = await ctx.host.askQuestion(input, ctx.signal);
    if ('cancelled' in result)
      return {
        ok: false,
        content:
          'The user cancelled the question. Do not invent an answer or repeat the same question.',
        summary: 'Skipped',
      };
    return {
      ok: true,
      content: JSON.stringify({ question: input.question, answer: result.answer }),
      summary: 'User answered',
      display: { kind: 'question', question: input.question, answer: result.answer },
    };
  },
});
