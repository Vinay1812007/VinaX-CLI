import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { server: 'src/server.ts', token: 'src/token.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: true,
  // One self-contained file per entry, so the Render service only needs `node dist/server.js`.
  noExternal: [/.*/],
});
