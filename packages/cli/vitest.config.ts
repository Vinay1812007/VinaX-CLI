import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'cli', include: ['test/**/*.test.ts', 'test/**/*.test.tsx'], testTimeout: 20_000 },
});
