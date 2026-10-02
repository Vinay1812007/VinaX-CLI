import { describe, expect, it, vi } from 'vitest';
import { askUserTool } from '../src/tools/question-tool.js';
import type { ToolContext } from '../src/tools/types.js';

describe('AskUserQuestion', () => {
  const input = { question: 'Which test runner?', options: ['Vitest', 'Jest'] };

  it('waits for the user and returns their actual answer to the model', async () => {
    const signal = new AbortController().signal;
    const askQuestion = vi.fn().mockResolvedValue({ answer: 'Use the existing tests' });
    const result = await askUserTool.run(input, {
      signal,
      host: { askQuestion },
    } as unknown as ToolContext);
    expect(askQuestion).toHaveBeenCalledWith(input, signal);
    expect(JSON.parse(result.content)).toEqual({
      question: input.question,
      answer: 'Use the existing tests',
    });
    expect(result.ok).toBe(true);
  });

  it('reports cancellation and provides a headless fallback without inventing an answer', async () => {
    const cancelled = await askUserTool.run(input, {
      signal: new AbortController().signal,
      host: { askQuestion: async () => ({ cancelled: true }) },
    } as unknown as ToolContext);
    expect(cancelled.summary).toBe('Skipped');
    expect(cancelled.ok).toBe(false);
    const headless = await askUserTool.run(input, {} as ToolContext);
    expect(headless.ok).toBe(false);
    expect(headless.content).toContain('Ask this in your reply');
  });

  it('accepts free text questions and rejects empty or oversized choices', () => {
    expect(askUserTool.input.parse({ question: 'What is the expected result?' })).toEqual({
      question: 'What is the expected result?',
      options: [],
    });
    expect(askUserTool.input.safeParse({ question: ' ', options: [] }).success).toBe(false);
    expect(askUserTool.input.safeParse({ ...input, options: [''] }).success).toBe(false);
    expect(
      askUserTool.input.safeParse({ ...input, options: Array(7).fill('Choice') }).success,
    ).toBe(false);
  });
});
