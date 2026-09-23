import os from 'node:os';

export interface EnvironmentInfo {
  cwd: string;
  platform: string;
  date: string;
}

export function currentEnvironment(cwd: string, now: Date = new Date()): EnvironmentInfo {
  return {
    cwd,
    platform: `${os.type()} ${os.release()} (${process.platform}/${process.arch})`,
    date: now.toISOString().slice(0, 10),
  };
}

/** System prompt for a tool-less chat turn (headless `-p` before the agent loop exists). */
export function chatSystemPrompt(env: EnvironmentInfo): string {
  return [
    "You are VinaX, a coding assistant that works inside the user's terminal.",
    'Be direct and brief. Answer in GitHub-flavored Markdown and put code in fenced blocks with a language tag.',
    'In this mode you cannot open files or run commands; rely only on what the user gives you, and say so when that is not enough.',
    'If you are not sure about something, say that plainly rather than guessing.',
    '',
    '# Environment',
    `- Working directory: ${env.cwd}`,
    `- Platform: ${env.platform}`,
    `- Date: ${env.date}`,
  ].join('\n');
}
