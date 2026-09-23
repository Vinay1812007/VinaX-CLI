import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { vinax: 'src/bin.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: false,
  // The private core package is bundled in; its own dependencies stay external.
  noExternal: ['@vinax/core'],
});
