import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * feature-plan-ux-page-fixes.md C17 (R2) / T-C17c, the unit half (the integration half is integration/setup-status):
 * the access step's `allCovered` is true only when every expected submitter has a chargeable code (and there is at least
 * one); it stays `done` at 1 of N and isComplete is unchanged; names never reach SetupStatus, so Home's payload (which
 * copies `steps`) carries none and Home never reads the gaps.
 */

vi.mock('server-only', () => ({}));
vi.mock('@/db', async () => {
  const { createFakeControlDb } = await import('../helpers/fake-control-db');
  const db = createFakeControlDb();
  return { getDb: async () => db, getDbForWrite: async () => db, getDbForAuth: async () => db, getDbForUrl: () => db, __db: db };
});

import * as dbModule from '@/db';
import { contracts, clins, chargeCodes, users, userChargeCodes } from '@/db/schema';
import type { FakeControlDb } from '../helpers/fake-control-db';
import { getSetupStatusInternal } from '@/server/internal/setup';

const db = (dbModule as unknown as { __db: FakeControlDb }).__db;
beforeEach(() => db.reset());

/** Script the counts: contracts, CLINs and chargeable codes 1; `employees` expected submitters, `withAccess` of them covered. */
async function statusWith(employees: number, withAccess: number) {
  db.onSelect(contracts, [{ n: 1 }]);
  db.onSelect(clins, [{ n: 1 }]);
  db.onSelect(chargeCodes, [{ n: 1 }]);
  db.onSelect(users, [{ n: employees }]);
  db.onSelect(userChargeCodes, [{ n: withAccess }]);
  const st = await getSetupStatusInternal();
  return { st, access: st.steps.find((s) => s.key === 'chargeCodeAccess')! };
}

describe('setup status: charge code access coverage (C17, T-C17c)', () => {
  it('2 of 3 → done but not allCovered, isComplete unchanged; 3 of 3 → allCovered; 0 employees → not allCovered', async () => {
    const partial = await statusWith(3, 2);
    expect(partial.access).toEqual({ key: 'chargeCodeAccess', done: true, required: true, allCovered: false, withAccess: 2, total: 3 });
    expect(partial.st.isComplete).toBe(true);
    expect((await statusWith(3, 3)).access.allCovered).toBe(true);
    expect((await statusWith(0, 0)).access).toMatchObject({ done: false, allCovered: false, total: 0 });
  });

  it('no names anywhere in SetupStatus; Home copies steps but never reads the gaps', async () => {
    const { st } = await statusWith(3, 2);
    expect(JSON.stringify(st)).not.toMatch(/names|missing/i);
    const home = readFileSync('src/server/internal/home.ts', 'utf8');
    expect(home).not.toMatch(/getSetupAccessGaps/);
  });

  it('the expected-submitter rule comes from EXPECTED_SUBMITTER_ROLES (no ne(role, admin) left)', () => {
    const src = readFileSync('src/server/internal/setup.ts', 'utf8');
    expect(src).not.toMatch(/ne\(users\.role, 'admin'\)/);
    expect(src.match(/inArray\(users\.role, \[\.\.\.EXPECTED_SUBMITTER_ROLES\]\)/g)).toHaveLength(3);
    expect(src).toMatch(/sql`\$\{userChargeCodes\.userId\} = users\.id`/);   // the outer column written literally
  });
});
