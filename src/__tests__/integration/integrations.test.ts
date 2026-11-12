import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import * as schema from '@/db/schema';
import { getTestDb, createTestUser, cleanupTestData, expectOk, expectFailure, createTestContract, createTestClin, createTestIndirectCode } from './helpers';

/**
 * feature-plan-ux-page-fixes.md C13 / T-C13b: saveMapping is one atomic upsert on mapping_unique_idx that returns the
 * row's id — the same id when it updates; deleteMapping validates the id, deletes, and says "That mapping no longer
 * exists." when nothing was deleted.
 */

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDb: async () => getTestDb(),
  getDbForAuth: async () => getTestDb(),
  getDbForUrl: () => getTestDb(),
  getDbForWrite: async () => getTestDb(),
}));
vi.mock('@/lib/tenant/context', () => ({ getTenantSlug: async () => 'test-tenant' }));
const h = vi.hoisted(() => ({ adminId: '' }));
vi.mock('@/lib/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session')>();
  const admin = async () => ({ id: h.adminId, email: 'admin@x', fullName: 'Admin', role: 'admin' });
  return { ...actual, requireSession: admin, requireAdmin: admin, requireAdminFresh: admin };
});

import {
  saveMapping, deleteMapping, setPersonMapping, matchPeopleByEmail, getSyncFailures, getIntegrationHub, getSendPreview, getSyncLogs,
} from '@/server/actions/integrations';
import { triggerQBOSync } from '@/server/actions/qbo';
import { saveIntegrationConnection } from '@/server/internal/integrations';
import { connectionExpiredError } from '@/lib/integrations/provider-errors';
import { SEND_RUNNING_MESSAGE } from '@/lib/integrations/sync-display';

describe('integration mappings (C13, T-C13b)', () => {
  let connectionId: string;
  // feature-plan-ux-integrations-billing.md I4: person (employee/vendor) rows go through setPersonMapping; C13 is a contract row.
  const base = () => ({ connectionId, entityType: 'contract', bytimeEntityId: '11111111-1111-4111-8111-111111111111', bytimeEntityName: 'Navy' });

  beforeEach(async () => {
    await cleanupTestData();
    h.adminId = (await createTestUser({ role: 'admin' })).id;
    const [c] = await getTestDb().insert(schema.integrationConnections).values({ provider: 'quickbooks_online', displayName: 'QuickBooks — Acme', connectedBy: h.adminId }).returning();
    connectionId = c.id;
  });
  afterEach(async () => { await cleanupTestData(); });

  it('saveMapping returns the id on insert, and the same id when it updates the same row', async () => {
    const first = await expectOk(saveMapping({ ...base(), externalEntityId: 'q1', externalEntityName: 'Ann QBO' }));
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
    const second = await expectOk(saveMapping({ ...base(), bytimeEntityName: 'Ann B', externalEntityId: 'q2', externalEntityName: 'Ann (new)' }));
    expect(second.id).toBe(first.id);
    const rows = await getTestDb().select().from(schema.integrationEntityMappings).where(eq(schema.integrationEntityMappings.connectionId, connectionId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ externalEntityId: 'q2', externalEntityName: 'Ann (new)', bytimeEntityName: 'Ann B' });
  });

  it('two concurrent saves of the same row don\'t race into a unique violation', async () => {
    const [a, b] = await Promise.all([
      saveMapping({ ...base(), externalEntityId: 'q1', externalEntityName: 'One' }),
      saveMapping({ ...base(), externalEntityId: 'q2', externalEntityName: 'Two' }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(await getTestDb().select().from(schema.integrationEntityMappings)).toHaveLength(1);
  });

  it('deleteMapping removes it; a second delete → "That mapping no longer exists."; a non-UUID → validation', async () => {
    const { id } = await expectOk(saveMapping({ ...base(), externalEntityId: 'q1', externalEntityName: 'Ann QBO' }));
    await expectOk(deleteMapping(id));
    expect(await getTestDb().select().from(schema.integrationEntityMappings)).toHaveLength(0);
    await expectFailure(deleteMapping(id), 'validation', /^That mapping no longer exists\.$/);
    await expectFailure(deleteMapping('temp-123'), 'validation', /Mapping is not a valid identifier/);
  });
});

// ---------------------------------------------------------------------------
// feature-plan-ux-integrations-billing.md I4–I9 (IN-5, IN-6, IN-7, IN-10, IN-14, IN-15)
// ---------------------------------------------------------------------------

const db = () => getTestDb();
const personRows = async (connectionId: string, userId: string) => (await db().select().from(schema.integrationEntityMappings)
  .where(eq(schema.integrationEntityMappings.connectionId, connectionId)))
  .filter((r) => r.bytimeEntityId === userId && (r.entityType === 'employee' || r.entityType === 'vendor'));
const employee = (externalId = 'e1') => ({ type: 'employee' as const, externalId, externalName: `Emp ${externalId}` });
const vendor = (externalId = 'v1') => ({ type: 'vendor' as const, externalId, externalName: `Vendor ${externalId}` });

describe('people matching (I4, I5)', () => {
  let qbo: string;
  let gusto: string;
  let person: string;

  beforeEach(async () => {
    await cleanupTestData();
    h.adminId = (await createTestUser({ role: 'admin' })).id;
    person = (await createTestUser({ fullName: 'Ann Person' })).id;
    [{ id: qbo }] = await db().insert(schema.integrationConnections).values({ provider: 'quickbooks_online', displayName: 'QuickBooks', connectedBy: h.adminId }).returning();
    [{ id: gusto }] = await db().insert(schema.integrationConnections).values({ provider: 'gusto', displayName: 'Gusto', connectedBy: h.adminId }).returning();
  });
  afterEach(async () => { await cleanupTestData(); });

  it('IN-5: employee → vendor leaves only the vendor; "Not matched" clears both', async () => {
    await expectOk(setPersonMapping({ connectionId: qbo, userId: person, match: employee() }));
    const { mapping } = await expectOk(setPersonMapping({ connectionId: qbo, userId: person, match: vendor() }));
    expect(mapping).toMatchObject({ entityType: 'vendor', externalEntityId: 'v1', bytimeEntityName: 'Ann Person' });
    expect((await personRows(qbo, person)).map((r) => r.entityType)).toEqual(['vendor']);
    await expectOk(setPersonMapping({ connectionId: qbo, userId: person, match: null }));
    expect(await personRows(qbo, person)).toHaveLength(0);
  });

  it('IN-5: a Gusto connection, an inactive person and an inactive connection are refused', async () => {
    await expectFailure(setPersonMapping({ connectionId: gusto, userId: person, match: employee() }), 'validation', /only for QuickBooks/);
    const inactive = (await createTestUser({ isActive: false })).id;
    await expectFailure(setPersonMapping({ connectionId: qbo, userId: inactive, match: employee() }), 'validation', /inactive or no longer exists/);
    await db().update(schema.integrationConnections).set({ isActive: false }).where(eq(schema.integrationConnections.id, qbo));
    await expectFailure(setPersonMapping({ connectionId: qbo, userId: person, match: employee() }), 'validation', /disconnected/);
    expect(await db().select().from(schema.integrationEntityMappings)).toHaveLength(0);
  });

  it('IN-5: two parallel choices for one person never leave both an employee and a vendor match', async () => {
    for (let i = 0; i < 5; i++) {
      const [a, b] = await Promise.all([
        setPersonMapping({ connectionId: qbo, userId: person, match: employee(`e${i}`) }),
        setPersonMapping({ connectionId: qbo, userId: person, match: vendor(`v${i}`) }),
      ]);
      expect(a.ok && b.ok).toBe(true);
      expect(await personRows(qbo, person)).toHaveLength(1);
    }
  });

  // The test DB has one connection (setup-db.ts, max 1), so parallel calls serialize anyway: prove the lock directly. A
  // second connection holds the person's advisory lock; setPersonMapping must WAIT on it (seen in pg_locks), then finish.
  it('IN-5: setPersonMapping waits on the per-person advisory lock (integration-mapping:{connection}:{user})', async () => {
    const URL = process.env.TEST_DATABASE_URL ?? 'postgresql://bytime:bytime_dev@localhost:5432/bytime_test';
    const holder = postgres(URL, { max: 1 });
    const observer = postgres(URL, { max: 1 });
    let settled = false;
    try {
      let call: Promise<unknown> | undefined;
      await holder.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${'integration-mapping:' + qbo + ':' + person}))`;
        const [key] = await tx<{ classid: string; objid: string }[]>`
          SELECT classid::text, objid::text FROM pg_locks WHERE locktype = 'advisory' AND granted AND pid = pg_backend_pid()`;
        call = setPersonMapping({ connectionId: qbo, userId: person, match: employee() }).finally(() => { settled = true; });
        for (let i = 0; ; i++) {
          const [{ w }] = await observer<{ w: number }[]>`
            SELECT count(*)::int AS w FROM pg_locks
            WHERE locktype = 'advisory' AND NOT granted AND classid::text = ${key.classid} AND objid::text = ${key.objid}`;
          if (w >= 1) break;
          // Without the lock the call finishes instead of waiting, and this fails.
          if (settled || i > 200) throw new Error(`setPersonMapping never waited on the person lock (settled: ${settled})`);
          await new Promise((r) => setTimeout(r, 25));
        }
        expect(settled).toBe(false);
      });
      expect(await call).toMatchObject({ ok: true });
      expect(await personRows(qbo, person)).toHaveLength(1);
    } finally {
      await holder.end({ timeout: 1 });
      await observer.end({ timeout: 1 });
    }
  });

  it('IN-5: saveMapping refuses employee and vendor rows ("Use the People tab.")', async () => {
    for (const entityType of ['employee', 'vendor']) {
      await expectFailure(saveMapping({ connectionId: qbo, entityType, bytimeEntityId: person, bytimeEntityName: 'Ann', externalEntityId: 'x', externalEntityName: 'X' }), 'validation', /^Use the People tab\.$/);
    }
    expect(await db().select().from(schema.integrationEntityMappings)).toHaveLength(0);
  });

  it('IN-6: a legacy double match → choosing one removes the other', async () => {
    await db().insert(schema.integrationEntityMappings).values([
      { connectionId: qbo, entityType: 'employee', bytimeEntityId: person, externalEntityId: 'e1' },
      { connectionId: qbo, entityType: 'vendor', bytimeEntityId: person, externalEntityId: 'v1' },
    ]);
    await expectOk(setPersonMapping({ connectionId: qbo, userId: person, match: employee('e1') }));
    expect((await personRows(qbo, person)).map((r) => [r.entityType, r.externalEntityId])).toEqual([['employee', 'e1']]);
  });

  it('IN-7: matchPeopleByEmail fills only unmatched people, de-duplicates users, refuses Gusto and inactive connections', async () => {
    const other = (await createTestUser({ fullName: 'Bo Other' })).id;
    await expectOk(setPersonMapping({ connectionId: qbo, userId: other, match: vendor('v9') }));
    const result = await expectOk(matchPeopleByEmail({
      connectionId: qbo,
      pairs: [
        { userId: person, match: employee('e1') },
        { userId: person, match: employee('e2') }, // duplicate user: the first pair wins
        { userId: other, match: employee('e3') }, // already matched: skipped
      ],
    }));
    expect(result).toEqual({ matched: 1, skipped: 1 });
    expect((await personRows(qbo, person)).map((r) => r.externalEntityId)).toEqual(['e1']);
    expect((await personRows(qbo, other)).map((r) => [r.entityType, r.externalEntityId])).toEqual([['vendor', 'v9']]);

    await expectFailure(matchPeopleByEmail({ connectionId: gusto, pairs: [{ userId: person, match: employee() }] }), 'validation', /only for QuickBooks/);
    await db().update(schema.integrationConnections).set({ isActive: false }).where(eq(schema.integrationConnections.id, qbo));
    await expectFailure(matchPeopleByEmail({ connectionId: qbo, pairs: [{ userId: other, match: employee() }] }), 'validation', /disconnected/);
  });
});

describe('sends: failures, the running guard, the hub, the preview (I6, I7, I9)', () => {
  let qbo: string;

  beforeEach(async () => {
    await cleanupTestData();
    h.adminId = (await createTestUser({ role: 'admin' })).id;
    ({ id: qbo } = await saveIntegrationConnection(db() as never, h.adminId, {
      provider: 'quickbooks_online', displayName: 'QuickBooks — Acme', externalCompanyId: 'realm-1', externalCompanyName: 'Acme',
      accessToken: 'a', refreshToken: 'r', tokenExpiresAt: new Date(Date.now() + 3_600_000),
    }));
  });
  afterEach(async () => { await cleanupTestData(); });

  const addLog = async (over: Partial<typeof schema.integrationSyncLogs.$inferInsert>) =>
    (await db().insert(schema.integrationSyncLogs).values({ connectionId: qbo, syncType: 'timesheet_push', status: 'success', ...over }).returning())[0];

  it('IN-10: getSyncFailures labels failed records "{person} · {code} · {date}" (raw when unknown); failed only', async () => {
    const pat = await createTestUser({ fullName: 'Pat Doe' });
    const contract = await createTestContract({ name: 'Navy' });
    const clin = await createTestClin(contract.id, { clinNumber: '0001' });
    const oh = await createTestIndirectCode({ code: 'OH-1' });
    const log = await addLog({ status: 'partial', recordsPushed: 1, recordsFailed: 3 });
    await db().insert(schema.integrationSyncRecords).values([
      { syncLogId: log.id, bytimeEntityType: 'timesheet_entry', bytimeEntityId: `${pat.id}-${clin.id}-2026-10-15`, status: 'failed', errorMessage: 'Bad item' },
      { syncLogId: log.id, bytimeEntityType: 'timesheet_entry', bytimeEntityId: `${pat.id}-${oh.id}-2026-10-16`, status: 'failed', errorMessage: null },
      { syncLogId: log.id, bytimeEntityType: 'timesheet_entry', bytimeEntityId: 'legacy-id', status: 'failed', errorMessage: 'Old' },
      { syncLogId: log.id, bytimeEntityType: 'timesheet_entry', bytimeEntityId: `${pat.id}-${clin.id}-2026-10-17`, status: 'success' },
    ]);
    // "See {n} failures" counts the stored failed records (not records_failed).
    expect((await getSyncLogs(qbo)).find((l) => l.id === log.id)?.failedRecords).toBe(3);
    const failures = await getSyncFailures(log.id);
    expect(failures.map((f) => [f.label, f.error])).toEqual([
      ['Pat Doe · Navy / 0001 · Oct 15, 2026', 'Bad item'],
      ['Pat Doe · OH-1 · Oct 16, 2026', null],
      ['legacy-id', 'Old'],
    ]);
  });

  it('IN-14: triggerQBOSync refuses while a running log under 15 minutes exists (no new log); a stale one doesn’t block', async () => {
    await addLog({ status: 'running', startedAt: new Date(), createdAt: new Date() });
    await expectFailure(triggerQBOSync({ connectionId: qbo, periodStart: '2026-10-01' as never }), 'validation', new RegExp(`^${SEND_RUNNING_MESSAGE}$`));
    expect(await db().select().from(schema.integrationSyncLogs)).toHaveLength(1);

    await db().delete(schema.integrationSyncLogs);
    const old = new Date(Date.now() - 20 * 60_000);
    await addLog({ status: 'running', startedAt: old, createdAt: old });
    const result = await triggerQBOSync({ connectionId: qbo, periodStart: '2026-10-01' as never });
    if (!result.ok) expect(result.error).not.toBe(SEND_RUNNING_MESSAGE);
    expect((await db().select().from(schema.integrationSyncLogs)).length).toBe(2); // the new send got its own log
  });

  // UX-4C2B-AUDIT.md F4: the one-connection test DB serializes calls anyway, so prove the send lock directly — a second
  // connection holds integration-send:{connection}; triggerQBOSync must WAIT on it (seen in pg_locks), then run.
  it('IN-14: triggerQBOSync takes the send lock (integration-send:{connection}) before claiming a log', async () => {
    const URL = process.env.TEST_DATABASE_URL ?? 'postgresql://bytime:bytime_dev@localhost:5432/bytime_test';
    const holder = postgres(URL, { max: 1 });
    const observer = postgres(URL, { max: 1 });
    let settled = false;
    try {
      let call: Promise<unknown> | undefined;
      await holder.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${'integration-send:' + qbo}))`;
        const [key] = await tx<{ classid: string; objid: string }[]>`
          SELECT classid::text, objid::text FROM pg_locks WHERE locktype = 'advisory' AND granted AND pid = pg_backend_pid()`;
        call = triggerQBOSync({ connectionId: qbo, periodStart: '2026-10-01' as never }).finally(() => { settled = true; });
        for (let i = 0; ; i++) {
          const [{ w }] = await observer<{ w: number }[]>`
            SELECT count(*)::int AS w FROM pg_locks
            WHERE locktype = 'advisory' AND NOT granted AND classid::text = ${key.classid} AND objid::text = ${key.objid}`;
          if (w >= 1) break;
          if (settled || i > 200) throw new Error(`triggerQBOSync never waited on the send lock (settled: ${settled})`);
          await new Promise((r) => setTimeout(r, 25));
        }
        // Nothing claimed while waiting (read on the observer: the test's own connection is parked in the waiting call).
        const [{ n }] = await observer<{ n: number }[]>`SELECT count(*)::int AS n FROM integration_sync_logs`;
        expect(n).toBe(0);
      });
      expect(await call).toMatchObject({ ok: true });
      expect(await db().select().from(schema.integrationSyncLogs)).toHaveLength(1);
    } finally {
      await holder.end({ timeout: 1 });
      await observer.end({ timeout: 1 });
    }
  });

  it('F8: triggerQBOSync refuses a Gusto connection and an inactive one, before any log', async () => {
    const [{ id: gusto }] = await db().insert(schema.integrationConnections).values({ provider: 'gusto', displayName: 'Gusto', connectedBy: h.adminId }).returning();
    await expectFailure(triggerQBOSync({ connectionId: gusto, periodStart: '2026-10-01' as never }), 'validation', /isn’t a QuickBooks Online connection/);
    await db().update(schema.integrationConnections).set({ isActive: false }).where(eq(schema.integrationConnections.id, qbo));
    await expectFailure(triggerQBOSync({ connectionId: qbo, periodStart: '2026-10-01' as never }), 'validation', /disconnected/);
    expect(await db().select().from(schema.integrationSyncLogs)).toHaveLength(0);
  });

  it('F11: getSyncLogs refuses a non-UUID connection and returns 1–100 rows', async () => {
    await expect(getSyncLogs('not-a-uuid')).rejects.toThrow(/not a valid identifier/);
    await db().insert(schema.integrationSyncLogs).values(Array.from({ length: 101 }, () => ({ connectionId: qbo, syncType: 'timesheet_push', status: 'success' as const })));
    expect(await getSyncLogs(qbo, 1000)).toHaveLength(100);
    expect(await getSyncLogs(qbo, 0)).toHaveLength(1);
    expect(await getSyncLogs(qbo)).toHaveLength(20);
  });

  it('IN-14: a date that isn’t a pay-period start is refused (no custom ranges)', async () => {
    await expectFailure(triggerQBOSync({ connectionId: qbo, periodStart: '2026-10-05' as never }), 'validation', /^Choose a pay period\.$/);
    expect(await db().select().from(schema.integrationSyncLogs)).toHaveLength(0);
  });

  it('IN-15: an expired failure after connecting → expired; reconnecting the same company clears it (same row)', async () => {
    await addLog({ status: 'failed', errorSummary: connectionExpiredError('QuickBooks').message, startedAt: new Date(Date.now() + 1000), createdAt: new Date(Date.now() + 1000) });
    expect((await getIntegrationHub()).qbo).toMatchObject({ id: qbo, expired: true });
    await new Promise((r) => setTimeout(r, 1100));
    const { id } = await saveIntegrationConnection(db() as never, h.adminId, {
      provider: 'quickbooks_online', displayName: 'QuickBooks — Acme', externalCompanyId: 'realm-1', externalCompanyName: 'Acme',
      accessToken: 'a2', refreshToken: 'r2', tokenExpiresAt: new Date(Date.now() + 3_600_000),
    });
    expect(id).toBe(qbo);
    expect((await getIntegrationHub()).qbo).toMatchObject({ id: qbo, expired: false });
  });

  it('IN-3 (server): the hub counts unmatched active people and the last send; no tokens leave the server', async () => {
    const ann = await createTestUser({ fullName: 'Ann' });
    await createTestUser({ fullName: 'Inactive', isActive: false });
    await expectOk(setPersonMapping({ connectionId: qbo, userId: ann.id, match: employee() }));
    await addLog({ status: 'success', recordsPushed: 42, recordsSkipped: 5 });
    const hub = await getIntegrationHub();
    expect(hub.qbo).toMatchObject({ companyName: 'Acme', unmatchedPeople: 1, lastSend: { pushed: 42, skipped: 5, status: 'success' } }); // the admin
    expect(hub.gusto).toBeNull();
    expect(JSON.stringify(hub)).not.toMatch(/Encrypted|enc:|"a2?"|refresh/i);
  });

  it('getSendPreview: unmatched people with approved hours, not-yet-approved people, and a legacy window as already sent', async () => {
    const pat = await createTestUser({ fullName: 'Pat' });
    const nora = await createTestUser({ fullName: 'Nora' }); // approved, no hours
    const sam = await createTestUser({ fullName: 'Sam' });   // submitted
    const rita = await createTestUser({ fullName: 'Rita' }); // returned
    const dan = await createTestUser({ fullName: 'Dan' });   // draft
    const contract = await createTestContract();
    const clin = await createTestClin(contract.id);
    await db().insert(schema.timesheetEntries).values({ userId: pat.id, clinId: clin.id, entryDate: '2026-10-02', hours: '8' });
    await db().insert(schema.timesheetPeriods).values([
      { userId: pat.id, periodStart: '2026-10-01', status: 'approved', periodNumDays: 15, reviewedAt: new Date() },
      { userId: nora.id, periodStart: '2026-10-01', status: 'approved', periodNumDays: 15, reviewedAt: new Date() },
      { userId: sam.id, periodStart: '2026-10-01', status: 'submitted', periodNumDays: 15, submittedAt: new Date() },
      { userId: rita.id, periodStart: '2026-10-01', status: 'rejected', periodNumDays: 15 },
      { userId: dan.id, periodStart: '2026-10-01', status: 'draft', periodNumDays: 15 },
      // Another period: not counted.
      { userId: sam.id, periodStart: '2026-10-16', status: 'submitted', periodNumDays: 16, submittedAt: new Date() },
    ]);
    await addLog({ status: 'success', recordsPushed: 12, periodStart: '2026-08-01', periodEnd: '2026-10-31' });
    const preview = await getSendPreview(qbo, '2026-10-01' as never);
    // UX-4C2B-AUDIT.md F5: exact counts — 3 not approved (submitted, returned, draft; inverting the filter gives 2), and
    // 1 unmatched (Pat has hours; Nora is approved without hours, so nothing of hers is sent).
    expect(preview).toMatchObject({ periodStart: '2026-10-01', periodEnd: '2026-10-15', unmatchedPeople: 1, notApprovedPeople: 3, partlySentAt: null });
    expect(preview.sentAt).toBeInstanceOf(Date);
    await expectOk(setPersonMapping({ connectionId: qbo, userId: pat.id, match: employee() }));
    expect((await getSendPreview(qbo, '2026-10-01' as never)).unmatchedPeople).toBe(0);
  });
});

/**
 * UX-4C2B-AUDIT.md F1: legacy data can hold several ACTIVE rows for one QuickBooks company (every old reconnect inserted
 * one). The hub, the page and the preview use the OLDEST (the row the old page mapped and sent against — the same row
 * reconnect revives), and the duplicate warning counts sends from every row of the same company.
 */
describe('F1: legacy duplicate active rows', () => {
  beforeEach(async () => {
    await cleanupTestData();
    h.adminId = (await createTestUser({ role: 'admin' })).id;
  });
  afterEach(async () => { await cleanupTestData(); });

  it('the oldest active row is used; a send logged on the newer row of the same company still warns', async () => {
    const row = (createdAt: string) => ({
      provider: 'quickbooks_online' as const, displayName: 'QuickBooks — Acme', externalCompanyId: 'realm-1', connectedBy: h.adminId,
      accessTokenEncrypted: 'x', refreshTokenEncrypted: 'y', createdAt: new Date(createdAt), connectedAt: new Date(createdAt),
    });
    const [oldest] = await db().insert(schema.integrationConnections).values(row('2026-01-01T00:00:00Z')).returning();
    const [newer] = await db().insert(schema.integrationConnections).values(row('2026-03-01T00:00:00Z')).returning();
    const [otherCompany] = await db().insert(schema.integrationConnections).values({ ...row('2026-02-01T00:00:00Z'), externalCompanyId: 'realm-2', isActive: false }).returning();

    const hub = await getIntegrationHub();
    expect(hub.qbo?.id).toBe(oldest.id); // the hub and the QuickBooks page (which reads the hub) use the oldest

    await db().insert(schema.integrationSyncLogs).values({
      connectionId: newer.id, syncType: 'timesheet_push', status: 'success', recordsPushed: 9, periodStart: '2026-10-01', periodEnd: '2026-10-15',
    });
    await db().insert(schema.integrationSyncLogs).values({
      connectionId: otherCompany.id, syncType: 'timesheet_push', status: 'success', recordsPushed: 9, periodStart: '2026-10-16', periodEnd: '2026-10-31',
    });
    expect((await getSendPreview(oldest.id, '2026-10-01' as never)).sentAt).toBeInstanceOf(Date);
    expect((await getSendPreview(oldest.id, '2026-10-16' as never)).sentAt).toBeNull(); // another company's send doesn't count
  });
});
