#!/usr/bin/env node
import { main } from './main.js';

const controller = new AbortController();
let interrupts = 0;
process.on('SIGINT', () => {
  interrupts++;
  if (interrupts > 1) process.exit(130);
  controller.abort();
});

const code = await main(process.argv.slice(2), undefined, controller.signal);
// Idle HTTP keep-alive sockets would otherwise hold the process open for several seconds.
// Exit once stdout and stderr have flushed so piped output is never cut short.
process.stdout.write('', () => {
  process.stderr.write('', () => process.exit(code));
});
