import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/integration/**/*.test.ts'],
    setupFiles: ['src/__tests__/integration/setup-db.ts'],
    testTimeout: 30000, // Integration tests may be slower
    hookTimeout: 30000,
    pool: 'forks',     // Each test file gets its own process
    fileParallelism: false, // Run files sequentially (shared DB)
    server: {
      deps: {
        // Force next-auth through Vite's transform (so the 'next/server' alias below applies)
        // instead of being externalized straight to Node's own strict ESM resolver.
        inline: [/next-auth/, /@auth\/core/],
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // next-auth's ESM build does `import ... from 'next/server'` with no extension. This
      // Next.js build's package.json has no "exports" map, so Node's strict ESM resolver
      // (used by Vite for externalized deps) can't resolve the bare specifier — only Next's
      // own webpack/Turbopack bundler tolerates that. Point it at the real file directly.
      'next/server': path.resolve(__dirname, './node_modules/next/server.js'),
    },
  },
});
