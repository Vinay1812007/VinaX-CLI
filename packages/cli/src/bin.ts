#!/usr/bin/env node
import { main } from './main.js';

const controller = new AbortController();
let interrupts = 0;
process.on('SIGINT', () => {
  interrupts++;
  if (interrupts > 1) process.exit(130);
  controller.abort();
});

process.exitCode = await main(process.argv.slice(2), undefined, controller.signal);
