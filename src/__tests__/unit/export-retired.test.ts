import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import * as lifecycleConfig from '@/lib/tenant/lifecycle-config';

/**
 * feature-plan-cloud-export.md §11 T16 (§6.8): the F2 local export is retired: no `tenant:export` script, no founder-export
 * path guard, no `export-destroyed`, no `founder-export-overdue`, no destroy-by receipt field, no BACKUP_RETENTION_DAYS.
 */
const ROOT = path.resolve(__dirname, '../../..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');
const walk = (dir: string): string[] => readdirSync(path.join(ROOT, dir)).flatMap((n) => {
  const rel = `${dir}/${n}`;
  if (n === 'node_modules' || n === '__tests__') return [];
  return statSync(path.join(ROOT, rel)).isDirectory() ? walk(rel) : /\.(ts|tsx|mjs|js)$/.test(n) ? [rel] : [];
});

describe('T16: the F2 local export is retired', () => {
  it('no tenant:export script or file; no founder-export path guard', () => {
    expect((JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts['tenant:export']).toBeUndefined();
    expect(existsSync(path.join(ROOT, 'scripts/tenant-export.ts'))).toBe(false);
    expect(existsSync(path.join(ROOT, 'src/lib/export/founder-export-path.ts'))).toBe(false);
  });

  it('no code names export-destroyed, founder-export-overdue, founder-export-taken, founderExportDestroyBy or BACKUP_RETENTION_DAYS', () => {
    const offenders = [...walk('src'), ...walk('scripts')].filter((f) => /export-destroyed|founder-export-overdue|founder-export-taken|founderExportDestroyBy|BACKUP_RETENTION_DAYS|tenant:export/.test(read(f)));
    expect(offenders).toEqual([]);
    expect('BACKUP_RETENTION_DAYS' in lifecycleConfig).toBe(false);
  });

  it('the receipt prints the export copies line; the export errors say "contact the lead"', () => {
    expect(read('scripts/delete-tenant.ts')).toContain('Export copies: ${r.exportCopies.delivered} delivered (expire automatically); ${r.exportCopies.openHolds} open hold(s)');
    const ws = read('src/lib/export/workspace-export.ts');
    expect(ws).not.toMatch(/use tenant:export/);
    expect(ws.match(/contact the lead\./g)?.length).toBe(3);
  });
});
