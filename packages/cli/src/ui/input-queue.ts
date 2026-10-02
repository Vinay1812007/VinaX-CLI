/** Only one interactive request owns the keyboard at a time, including nested agents. */
export class InputQueue {
  private waiting: (() => void)[] = [];
  private active: (() => void) | undefined;

  request<T>(
    signal: AbortSignal,
    show: (answer: (value: T) => void) => void,
    hide: () => void,
    cancelled: T,
  ): Promise<T> {
    if (signal.aborted) return Promise.resolve(cancelled);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: T): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        this.waiting = this.waiting.filter((item) => item !== start);
        if (this.active === start) {
          hide();
          this.active = undefined;
        }
        resolve(value);
        this.next();
      };
      const abort = (): void => finish(cancelled);
      const start = (): void => {
        if (signal.aborted) finish(cancelled);
        else show(finish);
      };
      signal.addEventListener('abort', abort, { once: true });
      this.waiting.push(start);
      this.next();
    });
  }

  private next(): void {
    if (this.active !== undefined) return;
    this.active = this.waiting.shift();
    this.active?.();
  }
}
