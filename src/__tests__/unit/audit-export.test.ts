import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * feature-plan-ux-people-codes.md §6.2, §6.5 — unit companions to integration AU-2, AU-3 and AU-8:
 * the ONE filter: the contract filter is a subquery on clins (no join, so the summary works), dates on entry_date, the
 * scope as user_id IN; "late" is the Approvals row rule; COUNTs map to numbers (static). The CSV line: the raw reason
 * code, the formula guard, the entered-at instant as ISO 8601 with the workspace offset. The keyset cursor stays in SQL
 * (a row-value comparison against the stored row, never a JS Date). The route: start/end required (400); 0 rows or more
 * than 50,000 → 422 before streaming; the stream writes the header and every batch; a mid-stream error fails the stream.
 */

const h = vi.hoisted(() => ({ built: [] as Array<{ toSQL: () => { sql: string; params: unknown[] } }>, rows: [] as unknown[][], cursor: null as unknown }));
vi.mock('server-only', () => ({}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: () => {} }));
vi.mock('@/lib/session', () => ({ requireApprover: async () => ({ id: 'a', role: 'admin' }), getEmployeeScope: async () => 'all' }));
vi.mock('@/server/internal/workspace-settings', () => ({ getWorkspaceTimezone: async () => 'America/New_York' }));
vi.mock('@/lib/rate-limit', () => ({ checkReportRateLimit: () => null }));

import { readFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/postgres-js';
import { timesheetEntries } from '@/db/schema';
import { AUDIT_CSV_HEADER, AUDIT_LATE_ROW, auditCsvLine, auditEntryWhere } from '@/server/internal/audit-export';

const mock = drizzle.mock();
const wrap = (b: object): object => new Proxy(b, {
  get(target, key) {
    if (key === 'then') return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => { h.built.push(target as never); return Promise.resolve(h.rows.shift() ?? []).then(res, rej); };
    const v = (target as Record<PropertyKey, unknown>)[key];
    if (typeof v !== 'function') return v;
    return (...args: unknown[]) => { const r = (v as (...a: unknown[]) => unknown).apply(target, args); return r && typeof r === 'object' && 'toSQL' in r ? wrap(r) : r; };
  },
});
const db = { select: (...a: unknown[]) => wrap((mock.select as (...x: unknown[]) => object)(...a)) };
vi.mock('@/db', () => ({ getDb: async () => db }));
const flat = (s: string) => s.replace(/\s+/g, ' ');
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

beforeEach(() => { h.built = []; h.rows = []; });

describe('the one filter (AU-2 / AU-3 companion)', () => {
  it('a summary-shaped query (timesheet_entries only) with every filter: the contract is a clins subquery, no join', () => {
    const where = auditEntryWhere(db as never, [ID(1), ID(2)], {
      userId: ID(1), contractId: ID(3), clinId: ID(4), startDate: '2026-10-01' as never, endDate: '2026-10-31' as never, reasonCode: 'CORRECTION', revisionsOnly: true,
    });
    const q = (mock.select({ n: timesheetEntries.id }).from(timesheetEntries).where(where) as unknown as { toSQL: () => { sql: string; params: unknown[] } }).toSQL();
    const s = flat(q.sql);
    expect(s).not.toMatch(/join/i);
    expect(s).toContain('"clin_id" in (select "id" from "clins" where "clins"."contract_id" = $');
    expect(s).toContain('"user_id" in ($1, $2)');
    expect(s).toMatch(/"entry_date" >= \$\d+ and "timesheet_entries"\."entry_date" <= \$\d+|"entry_date" >= \$\d+ and "entry_date" <= \$\d+/);
    expect(s).toMatch(/"revision_number" >= \$\d+/);
    expect(q.params).toEqual(expect.arrayContaining([ID(3), ID(4), '2026-10-01', '2026-10-31', 'CORRECTION', 2]));
  });

  it('no filters and everyone → no WHERE at all', () => {
    expect(auditEntryWhere(db as never, 'all', {})).toBeUndefined();
  });

  it('"late" is the Approvals row rule; the counts map to numbers (static)', () => {
    const q = (mock.select({ n: timesheetEntries.id }).from(timesheetEntries).where(AUDIT_LATE_ROW) as unknown as { toSQL: () => { sql: string; params: unknown[] } }).toSQL();
    expect(flat(q.sql)).toMatch(/"revision_number" = \$1 and "timesheet_entries"\."source" = \$2 and "timesheet_entries"\."change_reason_code" is not null|"revision_number" = \$1 and "source" = \$2 and "change_reason_code" is not null/);
    expect(q.params).toEqual([1, 'app']);
    const audit = readFileSync('src/server/actions/audit.ts', 'utf8');
    for (const k of ['entries', 'changed', 'late', 'people', 'total']) expect(audit, k).toMatch(new RegExp(`${k}: sql<number>\`[^\`]*\`\\.mapWith\\(Number\\)`));
  });
});

describe('the CSV line (AU-8 companion)', () => {
  const base = {
    entryDate: '2026-10-13', userName: 'Jane Smith', userEmail: 'jane@x', contractNumber: 'W58-001', clinNumber: '0001', chargeCodeId: 'cc', indirectCodeId: null,
    clinId: 'c', chargeCode: 'NAV-1', indirectCode: null, hours: '6.00', revisionNumber: 2, changeReasonCode: 'CORRECTION', comment: '=HYPERLINK("x")',
    createdAt: new Date('2026-10-15T13:12:00.123Z'), createdByName: 'Jane Smith', source: 'app', originalMetadata: null, importSourceSystem: null, importedAt: null, importedByName: null,
  };
  it('raw reason code; the formula guard; ISO 8601 with the workspace offset; the header has the 13 columns', () => {
    const line = auditCsvLine(base, 'America/New_York');
    expect(line).toContain(',CORRECTION,');
    expect(line).not.toContain('Correction,');
    expect(line).toContain(`"'=HYPERLINK(""x"")"`);
    expect(line).toContain('2026-10-15T09:12:00.123-04:00');
    expect(line.startsWith('2026-10-13,Jane Smith,jane@x,W58-001,0001,NAV-1,6.00,2,')).toBe(true);
    expect(AUDIT_CSV_HEADER).toHaveLength(13);
  });
});

describe('the keyset cursor and the route (AU-8 companion)', () => {
  it('batches: the cursor is a row-value comparison against the stored row (never a JS Date), newest first, 1,000 a batch', async () => {
    const { getAuditExportCursor } = await import('@/server/internal/audit-export');
    const cursor = await getAuditExportCursor({ startDate: '2026-10-01' as never, endDate: '2026-10-31' as never });
    h.rows = [[], []];
    await cursor.batch(null);
    await cursor.batch(ID(9));
    const first = flat(h.built[0].toSQL().sql), second = h.built[1].toSQL();
    expect(first).not.toContain('te_cursor');
    expect(flat(second.sql)).toContain('("timesheet_entries"."created_at", "timesheet_entries"."id") < (SELECT te_cursor.created_at, te_cursor.id FROM timesheet_entries te_cursor WHERE te_cursor.id = $');
    expect(second.params).toContain(ID(9));
    expect(second.params.some((p) => p instanceof Date)).toBe(false);
    expect(flat(second.sql)).toMatch(/order by "timesheet_entries"\."created_at" desc, "timesheet_entries"\."id" desc limit \$\d+/);
    expect(second.params).toContain(1000);
  });

  it('L3: the count pins the newest row in the same statement; the first batch is bounded by it (≤, in SQL)', async () => {
    const { getAuditExportCursor } = await import('@/server/internal/audit-export');
    const cursor = await getAuditExportCursor({ startDate: '2026-10-01' as never, endDate: '2026-10-31' as never });
    h.rows = [[{ n: 3, id: ID(7) }], [], []];
    expect(await cursor.count()).toBe(3);
    await cursor.batch(null);
    await cursor.batch(ID(9));
    const count = flat(h.built[0].toSQL().sql), first = h.built[1].toSQL(), second = flat(h.built[2].toSQL().sql);
    expect(count).toMatch(/^select COUNT\(\*\) OVER \(\), "id" from "timesheet_entries" where .* order by "timesheet_entries"\."created_at" desc, "timesheet_entries"\."id" desc limit \$\d+$/);
    expect(flat(first.sql)).toContain('("timesheet_entries"."created_at", "timesheet_entries"."id") <= (SELECT te_top.created_at, te_top.id FROM timesheet_entries te_top WHERE te_top.id = $');
    expect(first.params).toContain(ID(7));
    expect(second).toContain('< (SELECT te_cursor.created_at');
    expect(second).not.toContain('te_top');
  });

  const call = async (qs: string, cursor: { count: () => Promise<number>; batch: (id: string | null) => Promise<{ lines: string[]; lastId: string | null }> }) => {
    vi.resetModules();
    vi.doMock('@/server/internal/audit-export', async (orig) => ({ ...(await orig<typeof import('@/server/internal/audit-export')>()), getAuditExportCursor: async () => cursor }));
    const { GET } = await import('@/app/api/reports/audit-csv/route');
    return GET(new Request(`http://x/api/reports/audit-csv${qs}`) as never);
  };

  it('start and end are required (400); 0 rows → 422; over 50,000 → 422 — before any batch', async () => {
    const batch = vi.fn(async () => ({ lines: [], lastId: null }));
    expect((await call('?end=2026-10-31', { count: async () => 5, batch })).status).toBe(400);
    const zero = await call('?start=2026-10-01&end=2026-10-31', { count: async () => 0, batch });
    expect([zero.status, (await zero.json()).error]).toEqual([422, 'No entries in these dates.']);
    const many = await call('?start=2026-10-01&end=2026-10-31', { count: async () => 50_001, batch });
    expect([many.status, (await many.json()).error]).toEqual([422, 'More than 50,000 entries match. Choose a shorter date range.']);
    expect(batch).not.toHaveBeenCalled();
  });

  it('streams the header and every batch (following lastId); a mid-stream error fails the download', async () => {
    const batches = [{ lines: ['a', 'b'], lastId: ID(1) }, { lines: ['c'], lastId: null }];
    const batch = vi.fn(async (lastId: string | null) => { void lastId; return batches.shift()!; });
    const ok = await call('?start=2026-10-01&end=2026-10-31&reason=LATE_ENTRY&changed=1', { count: async () => 3, batch });
    expect(ok.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(ok.headers.get('content-disposition')).toBe('attachment; filename="audit-trail-2026-10-01-to-2026-10-31.csv"');
    expect(await ok.text()).toBe(`${AUDIT_CSV_HEADER.join(',')}\na\nb\nc\n`);
    expect(batch.mock.calls.map((c) => c[0])).toEqual([null, ID(1)]);
    const broken = await call('?start=2026-10-01&end=2026-10-31', { count: async () => 3, batch: async () => { throw new Error('db down'); } });
    await expect(broken.text()).rejects.toThrow();
  });
});
