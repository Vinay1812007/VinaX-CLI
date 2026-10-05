/** Only one interactive request owns the keyboard at a time, including nested agents. */
export class InputQueue {
  private waiting: (() => void)[] = [];
  private active: (() => void) | undefined;

  /** `onChange` hears how many requests wait behind the one on screen. */
  constructor(private readonly onChange?: (waiting: number) => void) {}

  /** Requests queued behind the one being shown. */
  get backlog(): number {
    return this.waiting.length;
  }

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
        this.onChange?.(this.waiting.length);
      };
      const abort = (): void => {
        finish(cancelled);
      };
      const start = (): void => {
        if (signal.aborted) finish(cancelled);
        else show(finish);
      };
      signal.addEventListener('abort', abort, { once: true });
      this.waiting.push(start);
      this.next();
      this.onChange?.(this.waiting.length);
    });
  }

  private next(): void {
    if (this.active !== undefined) return;
    this.active = this.waiting.shift();
    this.active?.();
  }
}
