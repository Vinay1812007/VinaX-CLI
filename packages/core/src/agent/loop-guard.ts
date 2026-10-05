import { createHash } from 'node:crypto';

/** Same call failing this often in one task: warn the model first, then stop. */
const FAIL_WARN = 2;
const FAIL_STOP = 3;
/** Same call returning the same result this often: warn, then stop (no progress). */
const REPEAT_WARN = 3;
const REPEAT_STOP = 5;
/** Model replies in a row whose tool calls all failed. */
const FAILING_STEPS_STOP = 5;

/** Polling tools legitimately repeat with the same input. */
const POLLING = new Set(['BashOutput', 'TodoWrite']);

function canonical(args: string): string {
  try {
    const sortKeys = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(sortKeys)
        : typeof v === 'object' && v !== null
          ? Object.fromEntries(
              Object.entries(v as Record<string, unknown>)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, x]) => [k, sortKeys(x)]),
            )
          : v;
    return JSON.stringify(sortKeys(JSON.parse(args)));
  } catch {
    return args.trim();
  }
}

const hash = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);

export interface LoopVerdict {
  /** Appended to the tool result so the model changes course. */
  nudge?: string;
  /** Set when the task should stop: why, in words for the user. */
  stop?: string;
}

/**
 * Notices a task going in circles: the same tool call failing again and again, the same call
 * returning the same result with nothing changing, or reply after reply of failing calls.
 */
export class LoopGuard {
  private readonly failures = new Map<string, number>();
  private readonly repeats = new Map<string, number>();
  private failingSteps = 0;
  private stepHadSuccess = false;
  private stepHadCalls = false;

  /** Records one finished call; the verdict may nudge the model or stop the task. */
  record(name: string, args: string, ok: boolean, result: string, label: string): LoopVerdict {
    this.stepHadCalls = true;
    const call = `${name}\0${canonical(args)}`;
    const shown = `${name}${label === '' ? '' : ` ${label}`}`;
    if (!ok) {
      const n = (this.failures.get(call) ?? 0) + 1;
      this.failures.set(call, n);
      const firstLine = result.split('\n').find((l) => l.trim() !== '') ?? '';
      if (n >= FAIL_STOP)
        return {
          stop: `\`${shown}\` failed ${String(n)} times with the same input (last error: ${firstLine.slice(0, 160)}).`,
        };
      if (n >= FAIL_WARN)
        return {
          nudge: `[VinaX: this exact call has now failed ${String(n)} times in this task. Do not repeat it unchanged: find the cause, try a different approach, or ask the user.]`,
        };
      return {};
    }
    this.stepHadSuccess = true;
    if (POLLING.has(name)) return {};
    const key = `${call}\0${hash(result)}`;
    const n = (this.repeats.get(key) ?? 0) + 1;
    this.repeats.set(key, n);
    if (n >= REPEAT_STOP)
      return {
        stop: `\`${shown}\` was called ${String(n)} times with the same input and returned the same result each time, so the task was not making progress.`,
      };
    if (n >= REPEAT_WARN)
      return {
        nudge: `[VinaX: you already made this exact call ${String(n - 1)} times and got this same result. Use what you have, or try something different.]`,
      };
    return {};
  }

  /** Ends a model reply; returns why to stop when too many replies in a row only failed. */
  endStep(): string | undefined {
    if (this.stepHadCalls && !this.stepHadSuccess) this.failingSteps++;
    else if (this.stepHadCalls) this.failingSteps = 0;
    this.stepHadCalls = false;
    this.stepHadSuccess = false;
    return this.failingSteps >= FAILING_STEPS_STOP
      ? `The last ${String(this.failingSteps)} replies only made tool calls that failed.`
      : undefined;
  }
}

/** What the user can do after a stuck task, appended to the explanation. */
export const STUCK_ADVICE =
  'Tell VinaX what to try instead (or what the error means), run the failing command yourself with `!` to look at it, or press Esc Esc to rewind.';
