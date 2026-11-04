import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { NextRequest } from 'next/server';

/**
 * feature-plan-ux-kit-contracts.md §4.5 / R-2, unit companion to integration/period-cost.test.ts, runnable without
 * Postgres. getPeriodCostByPeriod (scripted rows through the fake DB): guard first; n ∈ {3, 6, 12}; the last N completed
 * periods across a schedule change (weekly → semimonthly); each day bucketed into its period; rounding to the cent per
 * CLIN per period, then summed per contract (never per day, never per contract unrounded); contracts by name. The
 * period-cost-xlsx route (action mocked): 400 on a bad n; 422 when no hours; one sheet with a totals row per period and
 * the CO-D7 rates note; a non-admin → 403.
 */

const h = vi.hoisted(() => ({ calls: [] as string[], role: 'admin' }));
vi.mock('server-only', () => ({}));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {}, captureMessage: () => {} }));
vi.mock('@/lib/rate-limit', () => ({ checkReportRateLimit: () => null }));
vi.mock('@/db', async () => {
  const { createFakeControlDb } = await import('../helpers/fake-control-db');
  const db = createFakeControlDb();
  return { getDb: async () => db, getDbForWrite: async () => db, getDbForAuth: async () => db, getDbForUrl: () => db, __db: db };
});
vi.mock('@/lib/session', async () => {
  class AuthorizationError extends Error {
    constructor(public kind: 'unauthenticated' | 'forbidden', message: string) { super(message); this.name = 'AuthorizationError'; }
  }
  const requireAdmin = async () => {
    h.calls.push('guard');
    if (h.role !== 'admin') throw new AuthorizationError('forbidden', 'Forbidden');
    return { id: 'a', role: 'admin' };
  };
  return { AuthorizationError, requireAdmin, requireSession: requireAdmin, requireApprover: requireAdmin, getEmployeeScope: async () => 'all', assertCanAccessEmployee: async () => {} };
});
vi.mock('@/lib/http-errors', async () => {
  const { NextResponse } = await import('next/server');
  return {
    guardErrorResponse: (e: unknown) => ((e as { kind?: string })?.kind === 'forbidden'
      ? NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      : NextResponse.json({ error: 'Internal server error' }, { status: 500 })),
  };
});
vi.mock('@/server/internal/workspace-settings', () => ({ getWorkspaceToday: async () => '2026-12-15', getWorkspaceTimezone: async () => 'America/New_York' }));

import * as dbModule from '@/db';
import { payPeriodConfig, timesheetEntries } from '@/db/schema';
import type { FakeControlDb } from '../helpers/fake-control-db';
import { getPeriodCostByPeriod } from '@/server/actions/reports';
import { GET } from '@/app/api/reports/period-cost-xlsx/route';
import { CURRENT_RATES_NOTE } from '@/lib/cost-labels';

const db = (dbModule as unknown as { __db: FakeControlDb }).__db;
beforeEach(() => { db.reset(); h.calls = []; h.role = 'admin'; });

// Newest first, as loadScheduleResolver orders them: semimonthly from Nov 16, weekly before.
const SCHEDULE = [
  { periodType: 'semimonthly', anchorDate: '2026-01-01', weekStartDay: 1, effectiveFrom: '2026-11-16', createdAt: new Date() },
  { periodType: 'weekly', anchorDate: '2026-01-05', weekStartDay: 1, effectiveFrom: '1900-01-01', createdAt: new Date() },
];
const row = (clinId: string, contract: 'army' | 'navy', entryDate: string, hours: number, pricedCost: number, unpricedHours = 0) => ({
  clinId, contractId: contract, contractName: contract === 'army' ? 'Army IT Support' : 'Navy Logistics', contractNumber: contract === 'army' ? 'W1' : 'N2',
  entryDate, hours: String(hours), pricedCost: String(pricedCost), unpricedHours: String(unpricedHours),
});

describe('getPeriodCostByPeriod (R-2 companion)', () => {
  it('buckets by period across a schedule change; rounds per CLIN per period, then sums per contract', async () => {
    db.onSelect(payPeriodConfig, SCHEDULE);
    db.onSelect(timesheetEntries, [
      row('c3', 'navy', '2026-11-20', 1.333, 100.004),     // P3, listed first but sorted after Army
      row('c1', 'army', '2026-11-03', 4, 0.0025),          // P1: c1 two days of 0.0025 → 0.005 → 0.01 per CLIN
      row('c1', 'army', '2026-11-04', 4, 0.0025),
      row('c2', 'army', '2026-11-05', 2, 0.005, 2),        // P1: c2 0.005 → 0.01; the contract → 0.02
      row('c1', 'army', '2026-11-15', 8, 800),             // P2: the last weekly period (Nov 9 – 15)
      row('c1', 'army', '2026-11-16', 8, 800),             // P3: the first semimonthly period (Nov 16 – 30)
      row('c1', 'army', '2026-11-01', 99, 9900),           // before the range: never bucketed
    ]);
    const report = await getPeriodCostByPeriod(3);
    expect(h.calls).toEqual(['guard']);
    expect(report.periods).toEqual([
      { start: '2026-11-02', end: '2026-11-08' }, { start: '2026-11-09', end: '2026-11-15' }, { start: '2026-11-16', end: '2026-11-30' },
    ]);
    expect(report.rows.map((r) => [r.periodStart, r.contractName, r.hours, r.pricedCost, r.unpricedHours])).toEqual([
      ['2026-11-02', 'Army IT Support', 10, 0.02, 2],
      ['2026-11-09', 'Army IT Support', 8, 800, 0],
      ['2026-11-16', 'Army IT Support', 8, 800, 0],
      ['2026-11-16', 'Navy Logistics', 1.33, 100, 0],
    ]);
  });

  it('UX-4B1-AUDIT L7: contracts by name, then number, then id; a row whose hours, cost and unpriced are all 0 is skipped', async () => {
    db.onSelect(payPeriodConfig, SCHEDULE);
    const r = (contractId: string, name: string, number: string, hours: number) => ({
      clinId: `cl-${contractId}`, contractId, contractName: name, contractNumber: number, entryDate: '2026-11-03', hours: String(hours), pricedCost: String(hours * 10), unpricedHours: '0',
    });
    db.onSelect(timesheetEntries, [
      r('k3', 'Same', 'B-2', 1), r('k2', 'Same', 'A-1', 1), r('k9', 'Same', 'A-1', 1), r('k1', 'Same', 'A-1', 1),
      r('k0', 'Cleared', 'C-0', 0),                                  // cleared to 0 in this period
    ]);
    const report = await getPeriodCostByPeriod(3);
    expect(report.rows.map((x) => x.contractId)).toEqual(['k1', 'k2', 'k9', 'k3']);
  });

  it('guard first; n outside {3, 6, 12} is refused before any read', async () => {
    await expect(getPeriodCostByPeriod(4)).rejects.toThrow('Choose 3, 6 or 12 pay periods.');
    expect(db.ops).toEqual([]);
    h.role = 'supervisor';
    await expect(getPeriodCostByPeriod(6)).rejects.toThrow('Forbidden');
    expect(db.ops).toEqual([]);
  });

  it('static: one query — latest revisions, CLINs inner-joined, the cost-basis lateral', () => {
    const src = readFileSync('src/server/actions/reports.ts', 'utf8');
    const fn = src.slice(src.indexOf('export async function getPeriodCostByPeriod'));
    expect(fn).toContain('.innerJoin(clins, eq(timesheetEntries.clinId, clins.id))');
    expect(fn).toContain('.leftJoinLateral(COST_BASIS_LATERAL, sql`true`)');
    expect(fn).toContain('LATEST_REVISION');
    expect(fn.match(/await db\s*\.select\(/g)).toHaveLength(1);
  });
});

describe('period-cost-xlsx (R-2 companion)', () => {
  const req = (q = '') => new NextRequest(`http://localhost/api/reports/period-cost-xlsx${q}`);

  it('a bad n → 400 before the action runs', async () => {
    for (const q of ['?n=4', '?n=abc', '?n=']) expect((await GET(req(q))).status, q).toBe(400);
    expect(h.calls).toEqual([]);
  });

  it('no hours in the periods → 422 with the range in words', async () => {
    db.onSelect(payPeriodConfig, SCHEDULE);
    const res = await GET(req('?n=3'));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'No hours recorded between Nov 2 and Nov 30, 2026.' });
  });

  it('one sheet: rows per period × contract, a totals row per period (also an empty one), the rates note', async () => {
    db.onSelect(payPeriodConfig, SCHEDULE);
    db.onSelect(timesheetEntries, [row('c1', 'army', '2026-11-03', 4, 400), row('c3', 'navy', '2026-11-04', 2, 150.5, 1), row('c1', 'army', '2026-11-20', 8, 800)]);
    const res = await GET(req('?n=3'));
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as never);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Cost by pay period']);
    const values = (wb.worksheets[0].getSheetValues() as unknown[][]).filter(Boolean).map((r) => r.slice(1));
    expect(values[2]).toEqual([CURRENT_RATES_NOTE]);
    expect(values[3]).toEqual(['Period', 'Contract', 'Hours', 'Priced cost ($)', 'Unpriced hours']);
    expect(values.slice(4)).toEqual([
      ['Nov 2 – 8, 2026', 'Army IT Support (W1)', 4, 400, 0],
      ['Nov 2 – 8, 2026', 'Navy Logistics (N2)', 2, 150.5, 1],
      ['Nov 2 – 8, 2026', 'Total', 6, 550.5, 1],
      ['Nov 9 – 15, 2026', 'Total', 0, 0, 0],
      ['Nov 16 – 30, 2026', 'Army IT Support (W1)', 8, 800, 0],
      ['Nov 16 – 30, 2026', 'Total', 8, 800, 0],
    ]);
  });

  it('a non-admin → 403', async () => {
    h.role = 'supervisor';
    expect((await GET(req('?n=6'))).status).toBe(403);
  });
});
