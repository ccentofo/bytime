import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { stripComments } from '../helpers/source-scanner';

/**
 * feature-plan-ux-navigation-home.md §4.1 / T1: the moved pages. No code under src/ (tests excluded) or scripts/
 * still points at an old /admin/... URL — a plain substring scan, so template literals like `${appUrl}/admin/billing`
 * are caught — and next.config.ts redirects every old URL (307, specific rule before the wildcard).
 */

const ROOT = path.resolve(__dirname, '../../..');
export const OLD_ADMIN_PATHS = [
  '/admin/settings', '/admin/billing', '/admin/integrations', '/admin/integrations/quickbooks', '/admin/integrations/gusto',
  '/admin/integrations/payroll-export', '/admin/api-keys', '/admin/import', '/admin/migration', '/admin/notifications',
  '/admin/setup',   // feature-plan-ux-setup-import.md P1
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (name === '__tests__' || name === 'node_modules') return [];
    if (statSync(full).isDirectory()) return files(full);
    return /\.(ts|tsx|mts|mjs|js|jsx)$/.test(name) ? [full] : [];
  });
}

export function oldPathHits(src: string): string[] {
  const code = stripComments(src);
  return OLD_ADMIN_PATHS.filter((p) => code.includes(p));
}

describe('route moves (T1)', () => {
  it('no src/ or scripts/ file references an old /admin/... URL', () => {
    const offenders = [...files(path.join(ROOT, 'src')), ...files(path.join(ROOT, 'scripts'))].flatMap((f) => {
      const hits = oldPathHits(readFileSync(f, 'utf8'));
      return hits.length ? [`${path.relative(ROOT, f)}: ${hits.join(', ')}`] : [];
    });
    expect(offenders).toEqual([]);
  });

  it('fixture: template literals and plain strings are caught; comments are not', () => {
    expect(oldPathHits('const href = `${appUrl}/admin/billing`;')).toEqual(['/admin/billing']);
    expect(oldPathHits("redirect('/admin/integrations/gusto?x=1')")).toEqual(['/admin/integrations', '/admin/integrations/gusto']);
    expect(oldPathHits('// used to live at /admin/settings')).toEqual([]);
  });

  it('next.config.ts redirects every old URL with 307s, payroll-export before the integrations wildcard', async () => {
    const config = (await import('../../../next.config')).default as { redirects: () => Promise<Array<{ source: string; destination: string; permanent: boolean }>> };
    const rules = await config.redirects();
    const expected: Array<[string, string]> = [
      ['/admin/settings', '/settings/workspace'],
      ['/admin/billing', '/settings/billing'],
      ['/admin/integrations/payroll-export', '/admin/payroll-export'],
      ['/admin/integrations/:path*', '/settings/integrations/:path*'],
      ['/admin/api-keys', '/settings/api-keys'],
      ['/admin/import', '/settings/import'],
      ['/admin/migration', '/settings/migration'],
      ['/admin/notifications', '/profile/notifications'],
      ['/settings', '/settings/workspace'],
      ['/admin/setup', '/settings/setup'],   // SU-7 (feature-plan-ux-setup-import.md P1)
    ];
    for (const [source, destination] of expected) {
      expect(rules.find((r) => r.source === source), source).toMatchObject({ destination, permanent: false });
    }
    expect(rules.every((r) => r.permanent === false)).toBe(true);
    const idx = (s: string) => rules.findIndex((r) => r.source === s);
    expect(idx('/admin/integrations/payroll-export')).toBeLessThan(idx('/admin/integrations/:path*'));
  });

  it('no settings/page.tsx (the /settings config redirect runs first) and no settings/layout.tsx', () => {
    const dir = path.join(ROOT, 'src/app/(app)/settings');
    expect(readdirSync(dir)).not.toContain('page.tsx');
    expect(readdirSync(dir)).not.toContain('layout.tsx');
  });
});

// feature-plan-ux-kit-contracts.md §5 / C-6 -----------------------------------------------------------------------------
describe('route moves (UX-4b C-6)', () => {
  const rules = async () => ((await import('../../../next.config')).default as { redirects: () => Promise<Array<{ source: string; destination: string; permanent: boolean }>> }).redirects();

  it('/admin/dashboard → /admin/contracts (307)', async () => {
    expect((await rules()).find((r) => r.source === '/admin/dashboard')).toMatchObject({ destination: '/admin/contracts', permanent: false });
  });

  it('CC-1: /admin/indirect-codes → /admin/charge-codes?tab=indirect (307); no source file links to the old address', async () => {
    expect((await rules()).find((r) => r.source === '/admin/indirect-codes')).toMatchObject({ destination: '/admin/charge-codes?tab=indirect', permanent: false });
    const offenders = files(path.join(ROOT, 'src')).filter((f) => /\/admin\/indirect-codes/.test(stripComments(readFileSync(f, 'utf8'))));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it('no source file links to /admin/dashboard any more; Home\'s contracts item opens /admin/contracts', () => {
    const offenders = files(path.join(ROOT, 'src')).filter((f) => /['"`]\/admin\/dashboard/.test(stripComments(readFileSync(f, 'utf8'))));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
    expect(readFileSync(path.join(ROOT, 'src/lib/home/attention.ts'), 'utf8')).toContain("action: { label: 'Open contracts', href: '/admin/contracts' }");
  });

  it('the old report links on Labor categories: report=overlaps → ?reason=conflict FIRST, then any report → the Unpriced page', async () => {
    const all = await rules();
    const lc = all.filter((r) => r.source === '/admin/labor-categories') as Array<{ destination: string; permanent: boolean; has?: Array<{ type: string; key: string; value?: string }> }>;
    expect(lc).toEqual([
      expect.objectContaining({ has: [{ type: 'query', key: 'report', value: 'overlaps' }], destination: '/admin/reports/unpriced?reason=conflict', permanent: false }),
      expect.objectContaining({ has: [{ type: 'query', key: 'report' }], destination: '/admin/reports/unpriced', permanent: false }),
    ]);
  });

  it('no source file links to /admin/labor-categories?report any more; Home\'s overlap item opens the conflict view', () => {
    const offenders = files(path.join(ROOT, 'src')).filter((f) => /\/admin\/labor-categories\?report/.test(stripComments(readFileSync(f, 'utf8'))));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
    expect(readFileSync(path.join(ROOT, 'src/lib/home/attention.ts'), 'utf8')).toContain("href: '/admin/reports/unpriced?reason=conflict'");
  });
});

describe('removed dead code stays removed (UX-4B1-AUDIT L9)', () => {
  it('no src file defines or imports UnpricedNote, PricedBasisNote or getOverlappingAssignmentsReport', () => {
    const offenders = files(path.join(ROOT, 'src'))
      .filter((f) => /\b(UnpricedNote|PricedBasisNote|getOverlappingAssignmentsReport)\b/.test(stripComments(readFileSync(f, 'utf8'))))
      .map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });
});

