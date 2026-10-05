import { PassThrough, Writable } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { render } from 'ink';
import type { ReactNode } from 'react';
import { createRuntime, parseModelRef, type RouterEvent } from '@vinax/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActivityIndicator, SPINNER_FRAMES } from '../../src/ui/components/ActivityIndicator.js';
import { AssistantMarkdown } from '../../src/ui/components/Messages.js';
import { PlanPrompt } from '../../src/ui/components/PlanPrompt.js';
import { QuestionPrompt } from '../../src/ui/components/QuestionPrompt.js';
import { StatusLine } from '../../src/ui/components/StatusLine.js';
import { Select } from '../../src/ui/components/Select.js';
import { ThemeContext, resolveTheme } from '../../src/ui/theme.js';
import { ChatScreen } from '../../src/ui/components/ChatScreen.js';
import { openSession } from '../../src/session.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

/** Use Ink itself with in-memory terminal streams; no network or real terminal needed. */
async function terminal(node: ReactNode, columns = 80) {
  const frames: string[] = [];
  const stdout = Object.assign(
    new Writable({
      write(chunk, _encoding, done) {
        const text = stripVTControlCharacters(String(chunk));
        if (text.trim()) frames.push(text);
        done();
      },
    }),
    { columns, rows: 30, isTTY: true },
  );
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: () => undefined,
    ref: () => undefined,
    unref: () => undefined,
  });
  const app = render(
    <ThemeContext.Provider value={resolveTheme('dark', { NO_COLOR: '1' })}>
      {node}
    </ThemeContext.Provider>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: stdout as unknown as NodeJS.WriteStream,
      debug: true,
      interactive: true,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );
  cleanups.push(() => {
    app.unmount();
    stdin.destroy();
    stdout.destroy();
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  return {
    frames,
    frame: () => frames.at(-1) ?? '',
    type: async (text: string) => {
      stdin.write(text);
      await new Promise((resolve) => setTimeout(resolve, 40));
    },
  };
}

async function chat(script: ({ name: string; input: unknown }[] | string)[]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vinax-controls-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const runtime = await createRuntime({
    cwd: dir,
    env: {
      VINAX_HOME: path.join(dir, 'home'),
      VINAX_SECRETS_BACKEND: 'file',
    },
  });
  const messages: string[] = [];
  const ref = parseModelRef(runtime.settings.resolved.model);
  vi.spyOn(runtime.router, 'stream').mockImplementation(
    async function* (request): AsyncGenerator<RouterEvent> {
      messages.push(JSON.stringify(request.prepare?.(ref).messages ?? request.messages));
      await Promise.resolve();
      yield { type: 'attempt', ref };
      const next = script.shift() ?? 'Done.';
      if (typeof next === 'string') yield { type: 'text', text: next };
      else
        for (const [index, call] of next.entries())
          yield {
            type: 'tool_call_delta',
            index,
            id: `call_${String(index)}`,
            name: call.name,
            argsChunk: JSON.stringify(call.input),
          };
      yield { type: 'done', ref, usage: undefined };
    },
  );
  const { setup, writer } = await openSession(runtime, { kind: 'new' }, {});
  cleanups.push(() => setup.close());
  const t = await terminal(
    <ChatScreen
      runtime={runtime}
      setup={setup}
      session={writer}
      commands={[]}
      version="test"
      tips={[]}
      title="Interaction tests"
      editorMode="normal"
      onExit={() => undefined}
      onClear={() => undefined}
      onResume={() => undefined}
      onTheme={() => undefined}
    />,
  );
  return { ...t, dir, messages, setup };
}

describe('interactive controls', () => {
  it('animates multiple spinner frames while waiting for the model', async () => {
    const t = await terminal(<ActivityIndicator startedAt={Date.now()} outputChars={0} />);
    await vi.waitFor(() => {
      const glyphs = new Set(
        t.frames.map((frame) => frame.trim()[0]).filter((c) => SPINNER_FRAMES.includes(c ?? '')),
      );
      expect(glyphs.size).toBeGreaterThan(2);
    });
    expect(t.frame()).toContain('esc to interrupt');
  });

  it('accepts a selected choice and supports a custom typed answer', async () => {
    const onAnswer = vi.fn();
    const question = { question: 'Which runner?', options: ['Vitest', 'Jest'] };
    const t = await terminal(<QuestionPrompt question={question} onAnswer={onAnswer} />);
    await t.type('3');
    expect(t.frame()).toContain('Type your answer');
    await t.type('Use existing tests');
    await t.type('\r');
    expect(onAnswer).toHaveBeenCalledWith({ answer: 'Use existing tests' });
    const selected = vi.fn();
    const other = await terminal(<QuestionPrompt question={question} onAnswer={selected} />);
    await other.type('2');
    expect(selected).toHaveBeenCalledWith({ answer: 'Jest' });
  });

  it('cancels questions and plan approval with Escape', async () => {
    const onAnswer = vi.fn();
    const question = await terminal(
      <QuestionPrompt
        question={{ question: 'What should change?', options: [] }}
        onAnswer={onAnswer}
      />,
    );
    await question.type('\x1b');
    await vi.waitFor(() => {
      expect(onAnswer).toHaveBeenCalledWith({ cancelled: true });
    });
    const onDecide = vi.fn();
    const plan = await terminal(
      <PlanPrompt plan="1. Update the tests" width={80} onDecide={onDecide} />,
    );
    await plan.type('\x1b');
    await vi.waitFor(() => {
      expect(onDecide).toHaveBeenCalledWith({ approved: false, feedback: '' });
    });
  });

  it('offers auto mode as an explicit plan approval choice', async () => {
    const onDecide = vi.fn();
    const t = await terminal(
      <PlanPrompt plan="1. Update the tests" width={80} onDecide={onDecide} />,
    );
    await t.type('4');
    expect(onDecide).toHaveBeenCalledWith({ approved: true, mode: 'auto' });
  });

  it('does not submit disabled choices through Enter or number shortcuts', async () => {
    const onSelect = vi.fn();
    const t = await terminal(
      <Select
        items={[
          { label: 'Unavailable', value: 'disabled', disabled: true },
          { label: 'Available', value: 'enabled' },
        ]}
        onSelect={onSelect}
      />,
    );
    await t.type('\r');
    await t.type('1');
    expect(onSelect).not.toHaveBeenCalled();
    await t.type('2');
    expect(onSelect).toHaveBeenCalledWith('enabled');
  });

  it('scrolls a long plan while keeping approval choices visible', async () => {
    const plan = Array.from(
      { length: 60 },
      (_, i) => `${String(i + 1)}. Step ${String(i + 1)}`,
    ).join('\n');
    const t = await terminal(<PlanPrompt plan={plan} width={80} onDecide={() => undefined} />);
    expect(t.frame()).toContain('PgUp/PgDn');
    expect(t.frame()).toContain('Go ahead with this plan?');
    expect(t.frame().split('\n').length).toBeLessThanOrEqual(30);
    await t.type('\x1b[6~');
    expect(t.frame()).toContain('lines 15');
    expect(t.frame()).toContain('Go ahead with this plan?');
  });

  it('bounds a live code block but preserves the full completed answer', async () => {
    const markdown = `\`\`\`ts\n${Array.from({ length: 50 }, (_, i) => `const value${String(i)} = ${String(i)};`).join('\n')}\n\`\`\``;
    const live = await terminal(
      <AssistantMarkdown markdown={markdown} first width={80} maxLines={8} />,
    );
    expect(live.frame().split('\n').length).toBeLessThanOrEqual(10);
    expect(live.frame()).toContain('streaming');
    const done = await terminal(<AssistantMarkdown markdown={markdown} first width={80} />);
    expect(done.frame()).toContain('value0');
    expect(done.frame()).toContain('value49');
  });

  it.each(['default', 'acceptEdits', 'plan', 'auto'] as const)(
    'keeps %s mode visible on a narrow terminal',
    async (mode) => {
      const t = await terminal(
        <StatusLine
          mode={mode}
          model="groq:openai/gpt-oss-120b"
          contextPct={25}
          notice={undefined}
          hint={undefined}
          width={30}
        />,
        30,
      );
      expect(t.frame().trim().split('\n')).toHaveLength(1);
      expect(t.frame()).toContain(
        mode === 'default' ? 'manual' : mode === 'acceptEdits' ? 'accept edits' : mode,
      );
    },
  );

  it('cycles modes during an edit approval and applies the newly allowed edit', async () => {
    const t = await chat([
      [{ name: 'Write', input: { file_path: 'answer.txt', content: '42' } }],
      'Saved the answer.',
    ]);
    await t.type('save the answer');
    await t.type('\r');
    await vi.waitFor(() => {
      expect(t.frame()).toContain('Create answer.txt?');
    });
    await t.type('\x1b[Z');
    await vi.waitFor(() => {
      expect(t.frame()).toContain('Saved the answer.');
    });
    expect(t.frame()).toContain('accept edits on');
    expect(await fs.readFile(path.join(t.dir, 'answer.txt'), 'utf8')).toBe('42');
  });

  it('passes two model questions back in order without losing a prompt', async () => {
    const t = await chat([
      [
        {
          name: 'AskUserQuestion',
          input: { question: 'Which framework?', options: ['React', 'Vue'] },
        },
        {
          name: 'AskUserQuestion',
          input: { question: 'Which language?', options: ['TypeScript', 'JavaScript'] },
        },
      ],
      'I will use your choices.',
    ]);
    await t.type('build the app');
    await t.type('\r');
    await vi.waitFor(() => {
      expect(t.frame()).toContain('Which framework?');
    });
    expect(t.frame()).not.toContain('Which language?');
    await t.type('2');
    await vi.waitFor(() => {
      expect(t.frame()).toContain('Which language?');
    });
    await t.type('1');
    await vi.waitFor(() => {
      expect(t.frame()).toContain('I will use your choices.');
    });
    expect(t.messages.at(-1)).toContain('Vue');
    expect(t.messages.at(-1)).toContain('TypeScript');
    expect(t.frame()).toContain('Your answer: Vue');
    expect(t.frame()).toContain('Your answer: TypeScript');
  });

  it('prevents an already approved edit when plan mode is selected before execution', async () => {
    const t = await chat([
      [{ name: 'Write', input: { file_path: 'answer.txt', content: '42' } }],
      'I will stay in plan mode.',
    ]);
    let finishCheckpoint: () => void = () => undefined;
    const checkpoint = vi.spyOn(t.setup.checkpoints, 'capture').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishCheckpoint = resolve;
        }),
    );
    await t.type('\x1b[Z');
    await t.type('save the answer');
    await t.type('\r');
    await vi.waitFor(() => {
      expect(checkpoint).toHaveBeenCalled();
    });
    await t.type('\x1b[Z');
    expect(t.frame()).toContain('plan mode on');
    finishCheckpoint();
    await vi.waitFor(() => {
      expect(t.frame()).toContain('I will stay in plan mode.');
    });
    await expect(fs.readFile(path.join(t.dir, 'answer.txt'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('interrupts a waiting plan and accepts the next user message', async () => {
    const t = await chat([
      [{ name: 'ExitPlanMode', input: { plan: '1. Change the tests' } }],
      'Here is the explanation.',
    ]);
    await t.type('\x1b[Z');
    await t.type('\x1b[Z');
    await t.type('make a plan');
    await t.type('\r');
    await vi.waitFor(() => {
      expect(t.frame()).toContain('Go ahead with this plan?');
    });
    await t.type('\x03');
    await vi.waitFor(() => {
      expect(t.frame()).toContain('Interrupted');
    });
    await t.type('just explain');
    await t.type('\r');
    await vi.waitFor(() => {
      expect(t.frame()).toContain('Here is the explanation.');
    });
  });

  it('uses auto mode after explicit plan approval and executes the next edit', async () => {
    const t = await chat([
      [{ name: 'ExitPlanMode', input: { plan: '1. Save the answer' } }],
      [{ name: 'Write', input: { file_path: 'answer.txt', content: '42' } }],
      'Plan completed.',
    ]);
    await t.type('\x1b[Z');
    await t.type('\x1b[Z');
    await t.type('make a plan');
    await t.type('\r');
    await vi.waitFor(() => {
      expect(t.frame()).toContain('Go ahead with this plan?');
    });
    await t.type('4');
    await vi.waitFor(() => {
      expect(t.frame()).toContain('Plan completed.');
    });
    expect(t.frame()).toContain('auto mode on');
    expect(await fs.readFile(path.join(t.dir, 'answer.txt'), 'utf8')).toBe('42');
  });
});
