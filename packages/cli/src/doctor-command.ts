import { Command } from 'commander';
import { createRuntime, runDoctor, type Runtime } from '@vinax/core';
import { EXIT } from './exit-codes.js';
import { paint, type CliIO } from './io.js';
import { VERSION } from './version.js';

const ICON = { ok: '✔', warn: '⚠', fail: '✖' } as const;

export function doctorCommand(io: CliIO, setExit: (code: number) => void): Command {
  return new Command('doctor')
    .description('Check the installation, keys, search, shell and terminal')
    .action(async () => {
      let runtime: Runtime | undefined;
      try {
        runtime = await createRuntime({ cwd: io.cwd, env: io.env });
      } catch {
        // settings problems are reported by the settings check
      }
      const out = io.stdout as { columns?: number };
      const checks = await runDoctor({
        cwd: io.cwd,
        env: io.env,
        version: VERSION,
        ...(runtime === undefined ? {} : { runtime }),
        terminal: { isTTY: io.stdout.isTTY === true, columns: out.columns },
      });
      for (const c of checks) {
        const style = c.status === 'ok' ? 'green' : c.status === 'warn' ? 'yellow' : 'red';
        io.stdout.write(
          `${paint(io.stdout, style, ICON[c.status], io.env)} ${c.name.padEnd(14)} ${c.detail}\n`,
        );
      }
      if (checks.some((c) => c.status === 'fail')) setExit(EXIT.error);
    });
}
