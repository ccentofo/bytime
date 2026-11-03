import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * UX-4B1-AUDIT L8: getUnpricedExportData cleans its filters itself (an action never trusts its caller): an invalid id,
 * date or reason is dropped before any reader sees it, and the readers all get the same clean filters. Guard first.
 */

const h = vi.hoisted(() => ({ calls: [] as Array<[string, unknown]> }));
vi.mock('server-only', () => ({}));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {}, captureMessage: () => {} }));
vi.mock('@/db', () => ({ getDb: async () => ({}), getDbForWrite: async () => ({}) }));
vi.mock('@/lib/session', () => ({ requireAdmin: async () => { h.calls.push(['guard', null]); }, requireAdminFresh: vi.fn() }));
vi.mock('@/server/internal/cost-basis', () => {
  const rec = (name: string, value: unknown) => vi.fn(async (_db: unknown, f: unknown) => { h.calls.push([name, f]); return value; });
  return {
    allUnpricedGroups: rec('groups', []), overlapsInScope: rec('overlaps', []), unpricedEntries: rec('entries', { rows: [], truncated: false }),
    unpricedScopeNames: rec('scope', { contract: null, clinNumber: null, slinNumber: null }),
    overlappingAssignments: vi.fn(), unpricedFixText: vi.fn(), unpricedTotals: vi.fn(),
    unpricedReport: rec('report', { totals: {}, groups: [], unattachedOverlaps: [], outOfViewOverlaps: [], truncated: false }),
  };
});

import { getUnpricedExportData, getUnpricedReport } from '@/server/actions/labor-categories';

const SLIN = '44444444-4444-4444-8444-444444444444';

describe('getUnpricedExportData (L8)', () => {
  beforeEach(() => { h.calls = []; });
  it('drops invalid filters before any reader runs; guard first', async () => {
    await getUnpricedExportData({ contractId: 'nope', slinId: SLIN, start: '2026-02-30', end: '2026-03-31', reason: 'other' });
    expect(h.calls[0]).toEqual(['guard', null]);
    const clean = { slinId: SLIN, endDate: '2026-03-31' };
    expect(h.calls.slice(1).sort()).toEqual([['entries', clean], ['groups', clean], ['overlaps', clean], ['scope', clean]]);
  });

  it('UX-4B1-AUDIT M2: getUnpricedReport also returns the scope names, from the same clean filters', async () => {
    const r = await getUnpricedReport({ clinId: 'bad', slinId: SLIN });
    expect(r.scope).toEqual({ contract: null, clinNumber: null, slinNumber: null });
    expect(h.calls.slice(1).sort()).toEqual([['report', { slinId: SLIN }], ['scope', { slinId: SLIN }]]);
  });
});
