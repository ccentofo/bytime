import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node', // Server-side tests (default)
    include: ['src/__tests__/**/*.test.ts', 'src/__tests__/**/*.test.tsx'],
    setupFiles: ['src/__tests__/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/lib/**', 'src/server/actions/**'],
      exclude: ['src/__tests__/**'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
