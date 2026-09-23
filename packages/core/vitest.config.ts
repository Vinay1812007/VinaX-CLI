import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'core',
    include: ['test/**/*.test.ts'],
    // starting Git Bash on Windows runners takes seconds, not milliseconds
    testTimeout: process.platform === 'win32' ? 30_000 : 5_000,
  },
});
