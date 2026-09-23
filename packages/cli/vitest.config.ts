import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'cli',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    testTimeout: process.platform === 'win32' ? 60_000 : 20_000,
  },
});
