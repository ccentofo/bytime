/**
 * The backup bundle (feature-plan-database-backups.md §6.2): one esbuild command used by `npm run backup:bundle`, the
 * Dockerfile's builder stage, and U6's metafile check (which imports BUNDLE_OPTIONS so the inputs it checks are exactly
 * what ships). Output: build/backup/backup.cjs (git-ignored).
 *
 * feature-plan-cloud-export.md §10 (3d):
 * - `appVersionPlugin`: the export's manifest (src/lib/export/manifest.ts) imports `package.json` for APP_VERSION. The app
 *   keeps that import; here it resolves to a virtual module in the `app-version` namespace holding only `{ version }`, read
 *   at build time (`define` can't replace an imported binding, and `alias` doesn't apply to relative paths). So
 *   package.json is never a bundle input and stays off the deploy list (U6).
 * - `__TENANT_JOURNAL_LENGTH__`: the tenant migration journal's entry count (drizzle/meta/_journal.json), read at build
 *   time. The export task's schema check compares it with the workspace's applied migrations (§6.3 step 1b).
 */
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_VERSION_NAMESPACE = 'app-version';

/** The tenant journal's entry count (cwd = the repo root, or the image's /build). */
export function tenantJournalLength(root = process.cwd()) {
  const journal = JSON.parse(readFileSync(path.join(root, 'drizzle/meta/_journal.json'), 'utf8'));
  if (!Array.isArray(journal.entries) || journal.entries.length === 0) throw new Error('drizzle/meta/_journal.json has no entries');
  return journal.entries.length;
}

export const appVersionPlugin = {
  name: 'app-version',
  setup(b) {
    b.onResolve({ filter: /(^|\/)package\.json$/ }, (args) => {
      const root = b.initialOptions.absWorkingDir ?? process.cwd();
      const rel = path.relative(root, args.importer);
      return rel.startsWith(`src${path.sep}`) ? { path: 'package.json', namespace: APP_VERSION_NAMESPACE } : undefined;
    });
    b.onLoad({ filter: /.*/, namespace: APP_VERSION_NAMESPACE }, () => {
      const root = b.initialOptions.absWorkingDir ?? process.cwd();
      const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
      return { contents: JSON.stringify({ version }), loader: 'json' };
    });
  },
};

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
  plugins: [appVersionPlugin],
};

/** The build-time defines (a function: the journal is read when the bundle is built, not when this module loads). */
export function bundleDefines(root = process.cwd()) {
  return { __TENANT_JOURNAL_LENGTH__: String(tenantJournalLength(root)) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await build({ ...BUNDLE_OPTIONS, define: bundleDefines() });
}
