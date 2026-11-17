/**
 * The backup bundle (feature-plan-database-backups.md §6.2): one esbuild command used by `npm run backup:bundle`, the
 * Dockerfile's builder stage, and U6's metafile check (which imports BUNDLE_OPTIONS so the inputs it checks are exactly
 * what ships). Output: build/backup/backup.cjs (git-ignored).
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

export const BUNDLE_OPTIONS = {
  entryPoints: ['scripts/backup/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  conditions: ['react-server'],
  external: ['pg-native'],
  tsconfig: 'tsconfig.backup.json',
  outfile: 'build/backup/backup.cjs',
  legalComments: 'none',
  logLevel: 'warning',
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await build(BUNDLE_OPTIONS);
}
