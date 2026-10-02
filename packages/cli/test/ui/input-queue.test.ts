import { describe, expect, it, vi } from 'vitest';
import { InputQueue } from '../../src/ui/input-queue.js';

describe('interactive input queue', () => {
  it('keeps simultaneous questions separate and answers each exactly once', async () => {
    const queue = new InputQueue();
    const signal = new AbortController().signal;
    const hide = vi.fn();
    let answerFirst: (value: string) => void = () => undefined;
    let answerSecond: (value: string) => void = () => undefined;
    const showSecond = vi.fn((done: (value: string) => void) => {
      answerSecond = done;
    });
    const first = queue.request(
      signal,
      (done) => {
        answerFirst = done;
      },
      hide,
      'cancelled',
    );
    const second = queue.request(signal, showSecond, hide, 'cancelled');
    expect(showSecond).not.toHaveBeenCalled();
    answerFirst('first');
    expect(showSecond).toHaveBeenCalledOnce();
    answerFirst('duplicate');
    expect(hide).toHaveBeenCalledOnce();
    answerSecond('second');
    expect(await Promise.all([first, second])).toEqual(['first', 'second']);
    expect(hide).toHaveBeenCalledTimes(2);
  });

  it('cancels active and queued requests without leaving a stuck prompt', async () => {
    const queue = new InputQueue();
    const ac = new AbortController();
    const showQueued = vi.fn();
    const hide = vi.fn();
    const first = queue.request(ac.signal, vi.fn(), hide, 'cancelled');
    const second = queue.request(ac.signal, showQueued, hide, 'cancelled');
    ac.abort();
    expect(await Promise.all([first, second])).toEqual(['cancelled', 'cancelled']);
    expect(showQueued).not.toHaveBeenCalled();
    const show = vi.fn();
    expect(await queue.request(ac.signal, show, hide, 'cancelled')).toBe('cancelled');
    expect(show).not.toHaveBeenCalled();
    const next = queue.request(
      new AbortController().signal,
      (done) => done('ready'),
      hide,
      'cancelled',
    );
    expect(await next).toBe('ready');
  });
});
