/**
 * feature-plan-cloud-export.md §10 (3d): the tenant migration journal's entry count, set at build time by esbuild's
 * `define` (scripts/backup/bundle.mjs `bundleDefines`) and by both vitest configs. The export task's schema check
 * compares it with the workspace's applied migrations (§6.3 step 1b).
 */
declare const __TENANT_JOURNAL_LENGTH__: number;
