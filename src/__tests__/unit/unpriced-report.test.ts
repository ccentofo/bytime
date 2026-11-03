import { describe, it, expect, vi } from 'vitest';

/**
 * feature-plan-ux-kit-contracts.md §4.4 / U-1, U-1b, unit companion to integration/unpriced-report.test.ts, runnable
 * without Postgres: the grouped SQL's shape (rendered with drizzle.mock), the pure assembly (fix routing, pairs attached
 * BY LEVEL — a SLIN entry decided at the CLIN level gets the CLIN-level pair —, unattached and out-of-view pairs,
 * scope by contract), and the URL filter parser (legacy startDate/endDate honoured, invalid values ignored).
 */

vi.mock('server-only', () => ({}));
import { drizzle } from 'drizzle-orm/postgres-js';
import { assembleUnpricedReport, unpricedGroupsQuery, unpricedTotalsQuery, type GroupRow, type OverlapRow } from '@/server/internal/cost-basis';
import { parseUnpricedFilters, unpricedFiltersQuery } from '@/lib/unpriced-filters';

const db = drizzle.mock();
const flat = (s: string) => s.replace(/\s+/g, ' ');

describe('the grouped SQL (U-1)', () => {
  it('groups by the subquery\'s plain columns; the location is computed once inside; only filter values and the limit are parameters', () => {
    const { sql, params } = unpricedGroupsQuery(db as never, { contractId: 'c-1', startDate: '2026-01-01', reason: 'conflict' }, 1000, 0).toSQL();
    const q = flat(sql);
    expect(q).toMatch(/group by "basis", "level", "user_id", "loc", "code_key"/);
    expect(q).toMatch(/order by sum\("hours"\) desc, "basis", "level", "user_id", "loc", "code_key"/i);
    expect(q.match(/CASE WHEN cost_basis\.level = 'slin' THEN "timesheet_entries"\."slin_id" ELSE "timesheet_entries"\."clin_id" END as "loc"/g)).toHaveLength(1);
    expect(q).toContain(`inner join "clins" on "timesheet_entries"."clin_id" = "clins"."id"`);
    expect(q).toContain("cost_basis.basis <> 'priced'");
    expect(q).toContain("cost_basis.basis = 'conflict'");
    expect(params).toEqual(['2026-01-01', 'c-1', 1001]);
  });

  it('totals count the groups with count(*) over the same grouped subquery', () => {
    const q = flat(unpricedTotalsQuery(db as never, {}).toSQL().sql);
    expect(q).toMatch(/^select sum\("g_hours"\), COUNT\(\*\)::int, count\(distinct "user_id"\) from \(select "user_id", sum\("hours"\) as "g_hours" from/i);
    expect(q).toMatch(/group by "basis", "level", "user_id", "loc", "code_key"\) "g"$/);
  });
});

const row = (o: Partial<GroupRow>): GroupRow => ({
  basis: 'no-category', level: null, userId: 'u1', employeeName: 'Emily Davis', contractId: 'k1', contractName: 'Army', clinId: 'c1', clinNumber: '0001',
  loc: 'c1', locSlinId: null, locSlinNumber: null, codeKey: null, codeText: null, hours: '10.50', first: '2026-03-02', last: '2026-03-20', entries: 3, ...o,
});
const side = (id: string, from: string, to: string | null = null, code = id.toUpperCase()) => ({ assignmentId: id, lcatCode: code, title: code, effectiveDate: from, endDate: to });
const pair = (o: Partial<OverlapRow>): OverlapRow => ({
  userId: 'u2', employeeName: 'Robert Taylor', level: 'clin', contractId: 'k1', clinId: 'c1', slinId: null, clinNumber: '0001', slinNumber: null,
  a: side('a1', '2026-01-01'), b: side('b1', '2026-03-01'), ...o,
});
const totals = { hours: 1, groups: 1, employees: 1 };

describe('assembleUnpricedReport (U-1, U-1b)', () => {
  it('fix routing: no-category on a code → set the code\'s category; without a code → assign the employee; conflict → the pair\'s assignments', () => {
    const conflictPair = pair({});
    const r = assembleUnpricedReport({
      rows: [row({ codeKey: 'cc1', codeText: 'ARMY-0001' }), row({ userId: 'u3' }), row({ basis: 'conflict', level: 'clin', userId: 'u2', loc: 'c1' })],
      truncated: false, totals, allPairs: [conflictPair], ranges: [{ level: 'clin', userId: 'u2', loc: 'c1', first: '2026-03-02', last: '2026-03-20' }], filters: {},
    });
    expect(r.groups.map((g) => g.fix)).toEqual([
      { kind: 'set-code-category', chargeCodeId: 'cc1' },
      { kind: 'assign-category', userId: 'u3' },
      { kind: 'end-overlap', userId: 'u2', assignmentIds: ['a1', 'b1'] },
    ]);
    expect(r.groups[2].overlaps).toEqual([conflictPair]);
    expect(r.unattachedOverlaps).toEqual([]);
    expect(r.totals.overlaps).toBe(1);
  });

  it('a SLIN entry whose basis was decided at the CLIN level gets the CLIN-level pair; a SLIN-level pair attaches only to its SLIN group', () => {
    const clinPair = pair({ level: 'clin', clinId: 'c1', slinId: null });
    const slinPair = pair({ level: 'slin', clinId: 'c1', slinId: 's1', slinNumber: '0001AA', a: side('a2', '2026-01-01'), b: side('b2', '2026-01-01') });
    const r = assembleUnpricedReport({
      rows: [
        row({ basis: 'conflict', level: 'clin', userId: 'u2', loc: 'c1' }),           // entries on SLIN s1, no SLIN candidates → CLIN level
        row({ basis: 'conflict', level: 'slin', userId: 'u2', loc: 's1', locSlinId: 's1', locSlinNumber: '0001AA' }),
      ],
      truncated: false, totals, allPairs: [clinPair, slinPair],
      ranges: [{ level: 'clin', userId: 'u2', loc: 'c1', first: '2026-03-02', last: '2026-03-20' }, { level: 'slin', userId: 'u2', loc: 's1', first: '2026-03-02', last: '2026-03-20' }],
      filters: {},
    });
    expect(r.groups[0].overlaps).toEqual([clinPair]);
    expect(r.groups[1].overlaps).toEqual([slinPair]);
  });

  it('UX-4B1-AUDIT M1: under a SLIN filter the CLIN-level pair still attaches and counts; another CLIN\'s pair stays out', () => {
    const clinPair = pair({ level: 'clin', clinId: 'c1', slinId: null });
    const otherClin = pair({ level: 'clin', clinId: 'c2', slinId: null, userId: 'u9', a: side('a9', '2027-01-01'), b: side('b9', '2027-02-01') });
    const r = assembleUnpricedReport({
      rows: [row({ basis: 'conflict', level: 'clin', userId: 'u2', loc: 'c1' })],   // SLIN s1 entries decided at CLIN c1
      truncated: false, totals, allPairs: [clinPair, otherClin],
      ranges: [{ level: 'clin', userId: 'u2', loc: 'c1', first: '2026-03-02', last: '2026-03-20' }],
      filters: { slinId: 's1' }, slinClinId: 'c1',
    });
    expect(r.groups[0].overlaps).toEqual([clinPair]);
    expect(r.groups[0].fix).toEqual({ kind: 'end-overlap', userId: 'u2', assignmentIds: ['a1', 'b1'] });
    expect(r.totals.overlaps).toBe(1);
    expect(r.unattachedOverlaps).toEqual([]);
    // Attachment never depends on the scope: even without the SLIN's CLIN, the exact location match attaches the pair.
    const noClin = assembleUnpricedReport({
      rows: [row({ basis: 'conflict', level: 'clin', userId: 'u2', loc: 'c1' })], truncated: false, totals, allPairs: [clinPair],
      ranges: [{ level: 'clin', userId: 'u2', loc: 'c1', first: '2026-03-02', last: '2026-03-20' }], filters: { slinId: 's1' },
    });
    expect(noClin.groups[0].overlaps).toEqual([clinPair]);
    expect(noClin.totals.overlaps).toBe(1);
    // An unattached CLIN-level pair on the SLIN's CLIN is in scope; one elsewhere isn't.
    const future = pair({ level: 'clin', clinId: 'c1', slinId: null, userId: 'u5', a: side('a5', '2027-01-01'), b: side('b5', '2027-02-01') });
    const r2 = assembleUnpricedReport({ rows: [], truncated: false, totals, allPairs: [future, otherClin], ranges: [], filters: { slinId: 's1' }, slinClinId: 'c1' });
    expect(r2.unattachedOverlaps).toEqual([future]);
  });

  it('a pair attaches only to the same employee and only when its window meets the group\'s dates', () => {
    const otherUser = pair({ userId: 'u9' });
    const ended = pair({ a: side('a3', '2025-01-01', '2025-06-30'), b: side('b3', '2025-03-01', '2025-12-31') });
    const r = assembleUnpricedReport({
      rows: [row({ basis: 'conflict', level: 'clin', userId: 'u2', loc: 'c1' })], truncated: false, totals,
      allPairs: [otherUser, ended], ranges: [{ level: 'clin', userId: 'u2', loc: 'c1', first: '2026-03-02', last: '2026-03-20' }], filters: {},
    });
    expect(r.groups[0].overlaps).toEqual([]);
    expect(r.unattachedOverlaps).toEqual([otherUser, ended]);
  });

  it('U-1b: a future overlap with no entries is unattached; totals.overlaps counts every pair (= Home with no filters)', () => {
    const future = pair({ a: side('a4', '2027-01-01'), b: side('b4', '2027-02-01') });
    const r = assembleUnpricedReport({ rows: [], truncated: false, totals: { hours: 0, groups: 0, employees: 0 }, allPairs: [future, pair({})], ranges: [], filters: {} });
    expect(r.unattachedOverlaps).toEqual([future, pair({})]);
    expect(r.outOfViewOverlaps).toEqual([]);
    expect(r.totals.overlaps).toBe(2);
  });

  it('U-1b: with a contract filter, a pair on another contract is absent everywhere', () => {
    const elsewhere = pair({ contractId: 'k2', clinId: 'c9' });
    const r = assembleUnpricedReport({ rows: [], truncated: false, totals, allPairs: [elsewhere, pair({})], ranges: [], filters: { contractId: 'k1' } });
    expect(r.unattachedOverlaps).toEqual([pair({})]);
    expect(r.totals.overlaps).toBe(1);
  });

  it('U-1b: a pair whose conflict hours are all outside the date filter is out of view, not "no hours affected yet"', () => {
    const p = pair({});
    const r = assembleUnpricedReport({
      rows: [], truncated: false, totals: { hours: 0, groups: 0, employees: 0 }, allPairs: [p],
      ranges: [{ level: 'clin', userId: 'u2', loc: 'c1', first: '2026-03-02', last: '2026-03-20' }],   // unfiltered: hours in March
      filters: { startDate: '2026-06-01', endDate: '2026-06-30' },
    });
    expect(r.outOfViewOverlaps).toEqual([p]);
    expect(r.unattachedOverlaps).toEqual([]);
  });

  it('truncated passes through; totals are the exact totals, not the shown groups', () => {
    const r = assembleUnpricedReport({ rows: [row({})], truncated: true, totals: { hours: 1719, groups: 1200, employees: 40 }, allPairs: [], ranges: [], filters: {} });
    expect(r.truncated).toBe(true);
    expect(r.totals).toEqual({ hours: 1719, groups: 1200, employees: 40, overlaps: 0 });
  });
});

describe('URL filters (§4.4.2)', () => {
  const U = '55555555-5555-4555-8555-555555555555';
  it('start/end and the legacy startDate/endDate; ids must be UUIDs; dates real; reason=conflict only', () => {
    expect(parseUnpricedFilters({ startDate: '2026-01-01', endDate: '2026-01-31', contractId: U })).toEqual({ startDate: '2026-01-01', endDate: '2026-01-31', contractId: U });
    expect(parseUnpricedFilters({ start: '2026-02-01', end: '2026-02-28', startDate: '2026-01-01' })).toEqual({ startDate: '2026-02-01', endDate: '2026-02-28' });
    expect(parseUnpricedFilters({ contractId: 'nope', clinId: [U, 'x'], start: '2026-02-30', reason: 'other' })).toEqual({ clinId: U });
    expect(parseUnpricedFilters({ reason: 'conflict' })).toEqual({ reason: 'conflict' });
    expect(unpricedFiltersQuery({ contractId: U, startDate: '2026-01-01', reason: 'conflict' })).toBe(`contractId=${U}&start=2026-01-01&reason=conflict`);
  });
});
