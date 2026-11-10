import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { getTestDb, createTestUser, createTestContract, createTestClin, cleanupTestData } from './helpers';
import { approvalScopeWindowFindings } from '@/server/internal/approval-scope-window';
import { canApprove, loadApprovalFacts } from '@/server/internal/approval-rules';

/**
 * feature-plan-approval-scope.md §3 and §12.1, against Postgres:
 * AS-1  — the backfill statement READ FROM drizzle/0018_*.sql converts active supervisor membership into active,
 *         unreviewed scopes (an inactive supervisor's too), never an employee's or an inactive row; a re-run inserts
 *         nothing.
 * AS-2  — after the backfill, a fixture (2 supervisors, 3 employees) gives the same literal canApprove matrix as the old
 *         rule (a supervisor approved every employee sharing an active CLIN row).
 * AS-18 — the window check lists a supervisor's active membership row with no scope row, a role_changed to supervisor
 *         at or after --since, and an active unreviewed migrated scope whose membership row is inactive; it writes
 *         nothing.
 */

const ROOT = path.resolve(__dirname, '../../..');
/** The backfill statement exactly as the migration file holds it. */
function backfillSql(): string {
  const file = readdirSync(path.join(ROOT, 'drizzle')).find((f) => /^0018_.*\.sql$/.test(f));
  if (!file) throw new Error('drizzle/0018_*.sql not found');
  const chunks = readFileSync(path.join(ROOT, 'drizzle', file), 'utf8').split('--> statement-breakpoint');
  const stmt = chunks.find((c) => c.includes('INSERT INTO approval_scopes'));
  if (!stmt) throw new Error('the 0018 backfill statement is missing');
  return stmt;
}
const runBackfill = async () => getTestDb().execute(sql.raw(backfillSql()));

const db = () => getTestDb();
const scopes = async () => (await db().select().from(schema.approvalScopes)).map((r) => ({ ...r }));

describe('0018 backfill (AS-1)', () => {
  beforeEach(async () => { await cleanupTestData(); });
  afterEach(async () => { await cleanupTestData(); });

  it('active supervisor membership → active unreviewed migrated scopes (an inactive supervisor included); not employees, not inactive rows; a re-run inserts nothing', async () => {
    const admin = await createTestUser({ role: 'admin' });
    const sam = await createTestUser({ role: 'supervisor', fullName: 'Sam' });
    const gone = await createTestUser({ role: 'supervisor', fullName: 'Gone', isActive: false });
    const eve = await createTestUser({ role: 'employee', fullName: 'Eve' });
    const k = await createTestContract();
    const [c1, c2, c3] = [await createTestClin(k.id), await createTestClin(k.id), await createTestClin(k.id)];
    const at = new Date('2026-03-04T05:06:07.123Z');
    await db().insert(schema.userAssignments).values([
      { userId: sam.id, clinId: c1.id, isActive: true, assignedAt: at, assignedBy: admin.id },
      { userId: sam.id, clinId: c2.id, isActive: false, assignedBy: admin.id },        // inactive: not converted
      { userId: gone.id, clinId: c3.id, isActive: true },                               // inactive supervisor, no assigner
      { userId: eve.id, clinId: c1.id, isActive: true },                                // employee: not converted
      { userId: admin.id, clinId: c2.id, isActive: true },                              // admin: not converted
    ]);

    await runBackfill();
    const rows = (await scopes()).sort((a, b) => a.supervisorId.localeCompare(b.supervisorId));
    expect(rows.map((r) => [r.supervisorId, r.clinId, r.isActive, r.source, r.reviewedAt, r.grantedBy]).sort()).toEqual([
      [gone.id, c3.id, true, 'migration', null, null],
      [sam.id, c1.id, true, 'migration', null, admin.id],
    ].sort());
    expect(rows.find((r) => r.supervisorId === sam.id)!.grantedAt.toISOString()).toBe(at.toISOString());

    const again = await runBackfill() as unknown as { count: number };
    expect(again.count).toBe(0);
    expect(await scopes()).toHaveLength(2);
  });
});

describe('no silent loss or gain (AS-2)', () => {
  beforeEach(async () => { await cleanupTestData(); });
  afterEach(async () => { await cleanupTestData(); });

  it('after the backfill the canApprove matrix equals the old shared-CLIN rule, literally', async () => {
    const [s1, s2] = [await createTestUser({ role: 'supervisor' }), await createTestUser({ role: 'supervisor' })];
    const [e1, e2, e3] = [await createTestUser({ role: 'employee' }), await createTestUser({ role: 'employee' }), await createTestUser({ role: 'employee' })];
    const k = await createTestContract();
    const [c1, c2, c3] = [await createTestClin(k.id), await createTestClin(k.id), await createTestClin(k.id)];
    await db().insert(schema.userAssignments).values([
      { userId: s1.id, clinId: c1.id }, { userId: s1.id, clinId: c2.id },
      { userId: s2.id, clinId: c2.id }, { userId: s2.id, clinId: c3.id },
      { userId: e1.id, clinId: c1.id }, { userId: e2.id, clinId: c2.id }, { userId: e3.id, clinId: c3.id },
      { userId: e3.id, clinId: c1.id, isActive: false },                                  // inactive: never counted
    ]);
    const matrix = async () => {
      const f = await loadApprovalFacts(db() as never);
      return [s1, s2].map((s) => [s1, s2, e1, e2, e3].map((u) => (u.id === s.id ? '-' : canApprove(f, s.id, u.id) ? 'Y' : 'n')).join(''));
    };
    expect(await matrix()).toEqual(['-nnnn', 'n-nnn']);                                 // before: no scope rows at all
    await runBackfill();
    // Columns: s1 s2 e1 e2 e3. The old rule: s1 shared c1 (e1) and c2 (e2); s2 shared c2 (e2) and c3 (e3); peers never.
    expect(await matrix()).toEqual(['-nYYn', 'n-nYY']);
  });
});

describe('the window check (AS-18)', () => {
  beforeEach(async () => { await cleanupTestData(); });
  afterEach(async () => { await cleanupTestData(); });

  it('lists the three cases (and nothing else) and writes nothing', async () => {
    const admin = await createTestUser({ role: 'admin' });
    const sam = await createTestUser({ role: 'supervisor', fullName: 'Sam Window' });
    const kim = await createTestUser({ role: 'supervisor', fullName: 'Kim Fine' });
    const pat = await createTestUser({ role: 'supervisor', fullName: 'Pat Promoted' });
    const old = await createTestUser({ role: 'supervisor', fullName: 'Old Promotion' });
    const eve = await createTestUser({ role: 'employee', fullName: 'Eve Employee' });
    const k = await createTestContract({ name: 'Navy' });
    const [c1, c2, c3] = [await createTestClin(k.id, { clinNumber: '0001' }), await createTestClin(k.id, { clinNumber: '0002' }), await createTestClin(k.id, { clinNumber: '0003' })];
    await db().insert(schema.userAssignments).values([
      { userId: sam.id, clinId: c1.id, isActive: true },     // 1: active membership, no scope row
      { userId: kim.id, clinId: c1.id, isActive: true },     // has a scope row: fine
      { userId: kim.id, clinId: c2.id, isActive: false },    // 3: its migrated scope is still active and unreviewed
      { userId: kim.id, clinId: c3.id, isActive: false },    // reviewed migrated scope: fine
      { userId: eve.id, clinId: c2.id, isActive: true },     // an employee: never listed
    ]);
    await db().insert(schema.approvalScopes).values([
      { supervisorId: kim.id, clinId: c1.id, source: 'migration' },
      { supervisorId: kim.id, clinId: c2.id, source: 'migration' },
      { supervisorId: kim.id, clinId: c3.id, source: 'migration', reviewedAt: new Date() },
    ]);
    const since = new Date('2026-11-12T14:00:00Z');
    await db().insert(schema.adminChangeLog).values([
      { actorId: admin.id, entity: 'user', entityId: pat.id, action: 'role_changed', oldValue: { role: 'employee' }, newValue: { role: 'supervisor' }, createdAt: new Date('2026-11-12T14:01:00Z') },
      { actorId: admin.id, entity: 'user', entityId: old.id, action: 'role_changed', oldValue: { role: 'employee' }, newValue: { role: 'supervisor' }, createdAt: new Date('2026-11-12T13:59:00Z') },
      { actorId: admin.id, entity: 'user', entityId: eve.id, action: 'role_changed', oldValue: { role: 'supervisor' }, newValue: { role: 'employee' }, createdAt: new Date('2026-11-12T14:02:00Z') },
    ]);

    const snapshot = async () => JSON.stringify(await Promise.all([
      db().select().from(schema.userAssignments).orderBy(schema.userAssignments.id),
      db().select().from(schema.approvalScopes).orderBy(schema.approvalScopes.id),
      db().select().from(schema.adminChangeLog).orderBy(schema.adminChangeLog.id),
    ]));
    const before = await snapshot();
    const f = await approvalScopeWindowFindings(db() as never, since);
    expect(f.membershipWithoutScope.map((r) => [r.supervisorName, r.clinLabel])).toEqual([['Sam Window', 'Navy CLIN 0001']]);
    expect(f.promotedSince.map((r) => r.userName)).toEqual(['Pat Promoted']);
    expect(f.unreviewedWithoutMembership.map((r) => [r.supervisorName, r.clinLabel])).toEqual([['Kim Fine', 'Navy CLIN 0002']]);
    expect(await snapshot()).toBe(before);
  });
});
