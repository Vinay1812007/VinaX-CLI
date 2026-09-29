import { Command } from 'commander';
import { createRuntime, runDoctor, type DoctorCheck, type Runtime } from '@vinax/core';
import { EXIT } from './exit-codes.js';
import { CHECK_ICON, writeHealth } from './health.js';
import { paint, type CliIO } from './io.js';
import { VERSION } from './version.js';

async function collectChecks(io: CliIO): Promise<DoctorCheck[]> {
  let runtime: Runtime | undefined;
  try {
    runtime = await createRuntime({ cwd: io.cwd, env: io.env });
  } catch {
    // settings problems are reported by the settings check
  }
  const out = io.stdout as { columns?: number };
  return runDoctor({
    cwd: io.cwd,
    env: io.env,
    version: VERSION,
    ...(runtime === undefined ? {} : { runtime }),
    terminal: { isTTY: io.stdout.isTTY === true, columns: out.columns },
  });
}

export function doctorCommand(io: CliIO, setExit: (code: number) => void): Command {
  return new Command('doctor')
    .description('Check the installation, keys, search, shell and terminal (full details)')
    .action(async () => {
      const checks = await collectChecks(io);
      for (const c of checks) {
        const style =
          c.status === 'ok'
            ? 'green'
            : c.status === 'warn'
              ? 'yellow'
              : c.status === 'fail'
                ? 'red'
                : 'dim';
        io.stdout.write(
          `${paint(io.stdout, style, CHECK_ICON[c.status], io.env)} ${c.name.padEnd(14)} ${c.detail}\n`,
        );
      }
      if (checks.some((c) => c.status === 'fail')) setExit(EXIT.error);
    });
}

export function healthCommand(io: CliIO, setExit: (code: number) => void): Command {
  return new Command('health')
    .description('Concise health summary: runtime, providers, keys, models, gateway, MCP, tools')
    .action(async () => {
      const checks = await collectChecks(io);
      writeHealth(io, checks, (io.stdout as { columns?: number }).columns ?? 100);
      if (checks.some((c) => c.status === 'fail')) setExit(EXIT.error);
    });
}
