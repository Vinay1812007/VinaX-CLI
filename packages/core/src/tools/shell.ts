import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { execa, type ResultPromise } from 'execa';
import type { Env } from '../config/paths.js';

export interface ShellInfo {
  kind: 'posix' | 'git-bash' | 'powershell';
  path: string;
  /** Named in the Bash tool's description so the model writes the right syntax. */
  label: string;
}

const CWD_MARKER = '__VX_CWD__';

function firstExisting(candidates: readonly (string | undefined)[]): string | undefined {
  return candidates.find((c): c is string => c !== undefined && c !== '' && fs.existsSync(c));
}

/** bash on macOS/Linux; Git Bash on Windows when installed, otherwise PowerShell. */
export function detectShell(
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
): ShellInfo {
  if (platform !== 'win32') {
    const bash = firstExisting(['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash']);
    if (bash) return { kind: 'posix', path: bash, label: 'bash' };
    return { kind: 'posix', path: '/bin/sh', label: 'sh' };
  }
  const programFiles = [
    env.ProgramFiles,
    env['ProgramFiles(x86)'],
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs'),
  ];
  const gitBash = firstExisting([
    env.VINAX_GIT_BASH_PATH,
    ...programFiles.map((dir) => (dir ? path.join(dir, 'Git', 'bin', 'bash.exe') : undefined)),
  ]);
  if (gitBash) return { kind: 'git-bash', path: gitBash, label: 'Git Bash (bash on Windows)' };
  const systemRoot = env.SystemRoot ?? 'C:\\Windows';
  const pwsh = firstExisting([
    env.ProgramFiles && path.join(env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe'),
    path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ]);
  return { kind: 'powershell', path: pwsh ?? 'powershell.exe', label: 'Windows PowerShell' };
}

function wrap(info: ShellInfo, command: string): string[] {
  if (info.kind === 'powershell') {
    const script = [
      command,
      '$__vx = if ($?) { if ($LASTEXITCODE) { $LASTEXITCODE } else { 0 } } else { 1 }',
      `Write-Output ("${CWD_MARKER}" + (Get-Location).Path)`,
      'exit $__vx',
    ].join('\n');
    return ['-NoProfile', '-NonInteractive', '-Command', script];
  }
  const pwd = info.kind === 'git-bash' ? '$(pwd -W 2>/dev/null || pwd -P)' : '$(pwd -P)';
  return ['-c', `${command}\n__vx=$?\nprintf '\\n${CWD_MARKER}%s\\n' "${pwd}"\nexit $__vx`];
}

/** Removes the trailing working-directory marker; returns the cleaned output and the new cwd. */
export function splitCwdMarker(output: string): { output: string; cwd: string | undefined } {
  const idx = output.lastIndexOf(CWD_MARKER);
  if (idx === -1) return { output, cwd: undefined };
  const line = output
    .slice(idx + CWD_MARKER.length)
    .split(/\r?\n/)[0]
    ?.trim();
  let before = output.slice(0, idx);
  if (before.endsWith('\n')) before = before.slice(0, -1);
  if (before.endsWith('\r')) before = before.slice(0, -1);
  return { output: before, cwd: line === '' ? undefined : line };
}

export interface RunResult {
  output: string;
  exitCode: number | undefined;
  timedOut: boolean;
  interrupted: boolean;
  durationMs: number;
}

interface Job {
  id: string;
  command: string;
  process: ResultPromise;
  output: string;
  readOffset: number;
  exitCode: number | undefined;
  done: boolean;
}

const MAX_BUFFER = 20 * 1024 * 1024;
const IS_WINDOWS = process.platform === 'win32';

/**
 * Kills a command and everything it started. Commands run in their own process group, so a
 * `sleep` or dev server spawned by the shell does not outlive a timeout or an interrupt.
 */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (IS_WINDOWS) {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => undefined);
    return;
  }
  const signalGroup = (sig: NodeJS.Signals): void => {
    try {
      process.kill(-pid, sig);
    } catch {
      // already gone
    }
  };
  signalGroup('SIGTERM');
  setTimeout(() => {
    signalGroup('SIGKILL');
  }, 2000).unref();
}

const liveSessions = new Set<ShellSession>();
let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const s of liveSessions) s.killAll();
  });
}

/**
 * Runs commands one at a time in a fresh shell, carrying the working directory from one call to
 * the next (so `cd sub` persists) without keeping a long-lived interactive shell around.
 */
export class ShellSession {
  private dir: string;
  private readonly jobs = new Map<string, Job>();
  private jobCounter = 0;

  constructor(
    readonly info: ShellInfo,
    initialCwd: string,
    private readonly env: Env,
  ) {
    this.dir = initialCwd;
    liveSessions.add(this);
    installExitHook();
  }

  get cwd(): string {
    return this.dir;
  }

  private childEnv(): Record<string, string | undefined> {
    return {
      ...this.env,
      PAGER: 'cat',
      GIT_PAGER: 'cat',
      GIT_TERMINAL_PROMPT: '0',
      GIT_EDITOR: 'true',
      NO_COLOR: '1',
      VINAX: '1',
    };
  }

  async run(
    command: string,
    opts: { timeoutMs: number; signal: AbortSignal; onOutput?: (chunk: string) => void },
  ): Promise<RunResult> {
    const started = Date.now();
    const cwd = fs.existsSync(this.dir) ? this.dir : process.cwd();
    const child = execa(this.info.path, wrap(this.info, command), {
      cwd,
      env: this.childEnv(),
      extendEnv: false,
      stdin: 'ignore',
      all: true,
      reject: false,
      detached: !IS_WINDOWS,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
    });
    let timedOut = false;
    let interrupted = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, opts.timeoutMs);
    const onAbort = (): void => {
      interrupted = true;
      killTree(child.pid);
    };
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
    if (opts.onOutput) {
      child.all.setEncoding('utf8');
      child.all.on('data', (chunk: string) => {
        opts.onOutput?.(chunk.replace(new RegExp(`\\n?${CWD_MARKER}.*`), ''));
      });
    }
    const result = await child;
    clearTimeout(timer);
    opts.signal.removeEventListener('abort', onAbort);
    const all = typeof result.all === 'string' ? result.all : '';
    const { output, cwd: next } = splitCwdMarker(all);
    if (next !== undefined && fs.existsSync(next)) this.dir = next;
    return {
      output,
      exitCode: result.exitCode,
      timedOut,
      interrupted,
      durationMs: Date.now() - started,
    };
  }

  startBackground(command: string): string {
    const id = `job_${String(++this.jobCounter)}`;
    const process = execa(this.info.path, wrap(this.info, command), {
      cwd: this.dir,
      env: this.childEnv(),
      extendEnv: false,
      stdin: 'ignore',
      all: true,
      reject: false,
      buffer: false,
      detached: !IS_WINDOWS,
      windowsHide: true,
    });
    const job: Job = {
      id,
      command,
      process,
      output: '',
      readOffset: 0,
      exitCode: undefined,
      done: false,
    };
    process.all.setEncoding('utf8');
    process.all.on('data', (chunk: string) => {
      job.output = (job.output + chunk).slice(-MAX_BUFFER);
    });
    void process.then((r) => {
      job.done = true;
      job.exitCode = r.exitCode;
    });
    this.jobs.set(id, job);
    return id;
  }

  /** New output since the last read, plus whether the job has finished. */
  readJob(id: string): { output: string; done: boolean; exitCode: number | undefined } | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    const fresh = splitCwdMarker(job.output.slice(job.readOffset)).output;
    job.readOffset = job.output.length;
    return { output: fresh, done: job.done, exitCode: job.exitCode };
  }

  killJob(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.done) return false;
    killTree(job.process.pid);
    return true;
  }

  killAll(): void {
    for (const job of this.jobs.values()) if (!job.done) killTree(job.process.pid);
  }
}
