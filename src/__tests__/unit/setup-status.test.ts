import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * feature-plan-ux-setup-import.md §3.1 (unit; the integration half is integration/setup-status):
 * SU-1 — `timeAndWeek` is done only when the workweek is set.
 * The other steps' rules over scripted counts (pay schedule by a row or timesheet data; P3's covered group with admins),
 * requiredDone / isComplete over the six required steps, and C17: no names anywhere in SetupStatus (Home copies it).
 */

vi.mock('server-only', () => ({}));
vi.mock('@/server/internal/pay-period-config', () => ({ getCurrentEffectiveConfigInternal: async () => ({ periodType: 'semimonthly', anchorDate: '2026-01-01', weekStartDay: 1 }) }));
vi.mock('@/db', async () => {
  const { createFakeControlDb } = await import('../helpers/fake-control-db');
  const db = createFakeControlDb();
  return { getDb: async () => db, getDbForWrite: async () => db, getDbForAuth: async () => db, getDbForUrl: () => db, __db: db };
});

import * as dbModule from '@/db';
import { contracts, clins, chargeCodes, users, userChargeCodes, indirectChargeCodes, laborCategories } from '@/db/schema';
import type { FakeControlDb } from '../helpers/fake-control-db';
import { SETUP_FLAGS_FROM, getSetupStatusInternal } from '@/server/internal/setup';

const db = (dbModule as unknown as { __db: FakeControlDb }).__db;
beforeEach(() => db.reset());

type Flags = { workweekSet: boolean; payConfigSet: boolean; hasTimesheetData: boolean; connection: boolean; clinsWithoutCode: number; adminsWithAccess: number };
const ALL_SET: Flags = { workweekSet: true, payConfigSet: true, hasTimesheetData: false, connection: false, clinsWithoutCode: 0, adminsWithAccess: 0 };

/** Script the counts (each 1 unless given) and the combined flags row. */
async function statusWith(o: { employees?: number; withAccess?: number; contracts?: number; flags?: Partial<Flags> } = {}) {
  db.onSelect(indirectChargeCodes, [{ n: 1 }]);
  db.onSelect(contracts, [{ n: o.contracts ?? 1 }]);
  db.onSelect(clins, [{ n: 1 }]);
  db.onSelect(chargeCodes, [{ n: 1 }]);
  db.onSelect(laborCategories, [{ n: 1 }]);
  db.onSelect(users, [{ n: o.employees ?? 1 }]);
  db.onSelect(userChargeCodes, [{ n: o.withAccess ?? 1 }]);
  db.onSelect(SETUP_FLAGS_FROM, [{ ...ALL_SET, ...o.flags }]);
  const st = await getSetupStatusInternal();
  return { st, step: (k: string) => st.steps.find((s) => s.key === k)! };
}

describe('setup status (§3.1)', () => {
  it('SU-1: the workweek unset → timeAndWeek not done (and setup incomplete); set → done', async () => {
    const unset = await statusWith({ flags: { workweekSet: false } });
    expect(unset.step('timeAndWeek').done).toBe(false);
    expect([unset.st.requiredDone, unset.st.requiredTotal, unset.st.isComplete]).toEqual([5, 6, false]);
    const set = await statusWith();
    expect(set.step('timeAndWeek').done).toBe(true);
    expect([set.st.requiredDone, set.st.isComplete]).toEqual([6, true]);
  });

  it('pay schedule: a row OR timesheet data; neither → not done', async () => {
    expect((await statusWith({ flags: { payConfigSet: false, hasTimesheetData: true } })).step('paySchedule').done).toBe(true);
    expect((await statusWith({ flags: { payConfigSet: false, hasTimesheetData: false } })).step('paySchedule').done).toBe(false);
  });

  it('P3: admins with a chargeable code count for People and the covered group; w and m are counts only', async () => {
    const adminsOnly = await statusWith({ employees: 0, withAccess: 0, flags: { adminsWithAccess: 1 } });
    expect(adminsOnly.step('people').done).toBe(true);
    expect(adminsOnly.step('chargeCodeAccess')).toEqual({ key: 'chargeCodeAccess', required: true, done: true, withAccess: 1, total: 1 });
    const partial = await statusWith({ employees: 3, withAccess: 1, flags: { adminsWithAccess: 1 } });
    expect(partial.step('chargeCodeAccess')).toMatchObject({ done: true, withAccess: 2, total: 4 });
    expect(partial.st.isComplete).toBe(true);
    const nobody = await statusWith({ employees: 2, withAccess: 0 });
    expect([nobody.step('people').done, nobody.step('chargeCodeAccess').done, nobody.st.isComplete]).toEqual([true, false, false]);
  });

  it('the order: six required in dependency order, then three recommended', async () => {
    const { st } = await statusWith();
    expect(st.steps.map((s) => [s.key, s.required])).toEqual([
      ['timeAndWeek', true], ['paySchedule', true], ['contractsClins', true], ['chargeCodes', true], ['people', true], ['chargeCodeAccess', true],
      ['indirectCodes', false], ['laborCategories', false], ['connection', false],
    ]);
  });

  it('C17: no names anywhere in SetupStatus; Home never reads the gaps', async () => {
    const { st } = await statusWith({ employees: 3, withAccess: 2 });
    expect(JSON.stringify(st)).not.toMatch(/names|missing/i);
    expect(readFileSync('src/server/internal/home.ts', 'utf8')).not.toMatch(/getSetupAccessGaps|getSetupPageData/);
  });

  it('≤ 8 parallel queries: the 7 counts and one combined statement (static)', () => {
    const src = readFileSync('src/server/internal/setup.ts', 'utf8');
    const status = src.slice(src.indexOf('export async function getSetupStatusInternal'), src.indexOf('export interface SetupAccessGaps'));
    const burst = status.slice(status.indexOf('await Promise.all(['), status.indexOf(']);', status.indexOf('await Promise.all([')));
    expect((burst.match(/^\s{4}(db\.select|chargeableAccess)\(/gm) ?? []).length).toBe(8);
    expect(src).not.toMatch(/ne\(users\.role, 'admin'\)/);
    expect(src).toMatch(/sql`\$\{userChargeCodes\.userId\} = users\.id`/);   // the outer column written literally
  });
});
