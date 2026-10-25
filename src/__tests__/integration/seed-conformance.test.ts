import { describe, it, expect, afterAll, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { getTestDb, cleanupTestData } from './helpers';

/**
 * Certified outputs fix round 1, T3 (C8): the demo seeder conforms to the rules the app enforces — run it TWICE (it
 * clears and re-seeds), then: every approved period's reviewer passes canApprove; every non-draft period has a
 * `submitted` event and every approved one an `approved` event; workweek = Monday (1); every leave code has a pay type;
 * exactly one baseline self_approval row.
 */

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDb: async () => getTestDb(),
  getDbForWrite: async () => getTestDb(),
  getDbForAuth: async () => getTestDb(),
  getDbForUrl: () => getTestDb(),
}));

import { seedRichData } from '../../../scripts/seed-full';
import { canApprove, loadApprovalFacts } from '@/server/internal/approval-rules';

describe('seeder conformance (T3)', () => {
  afterAll(async () => { await cleanupTestData(); });

  it('seeded twice: approvals by permitted reviewers, period events, workweek, leave pay types, one baseline row', async () => {
    await cleanupTestData();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const db = getTestDb() as never;
    await seedRichData(db);
    await seedRichData(db);

    const t = getTestDb();
    const facts = await loadApprovalFacts(t);
    const periods = await t.select().from(schema.timesheetPeriods);
    expect(periods.length).toBeGreaterThan(0);
    const approved = periods.filter((p) => p.status === 'approved');
    expect(approved.length).toBeGreaterThan(0);
    for (const p of approved) {
      expect(p.reviewedBy, p.id).not.toBeNull();
      expect(canApprove(facts, p.reviewedBy!, p.userId), `reviewer of ${p.id}`).toBe(true);
    }

    const events = await t.select({ periodId: schema.periodEvents.periodId, event: schema.periodEvents.event, source: schema.periodEvents.source })
      .from(schema.periodEvents).where(inArray(schema.periodEvents.periodId, periods.map((p) => p.id)));
    const has = (periodId: string, event: string) => events.some((e) => e.periodId === periodId && e.event === event);
    for (const p of periods.filter((x) => x.status !== 'draft')) expect(has(p.id, 'submitted'), `submitted event for ${p.id}`).toBe(true);
    for (const p of approved) expect(has(p.id, 'approved'), `approved event for ${p.id}`).toBe(true);
    expect(events.every((e) => e.source === 'app')).toBe(true);

    const [settings] = await t.select().from(schema.workspaceSettings);
    expect(settings.workweekStartDay).toBe(1);

    const leave = await t.select().from(schema.indirectChargeCodes).where(eq(schema.indirectChargeCodes.category, 'leave'));
    expect(leave.length).toBeGreaterThan(0);
    for (const c of leave) expect(c.leavePayType, c.code).not.toBeNull();

    const baseline = await t.select().from(schema.adminChangeLog).where(and(eq(schema.adminChangeLog.entity, 'self_approval')));
    expect(baseline).toHaveLength(1);
    expect(baseline[0]).toMatchObject({ action: 'enabled', newValue: expect.objectContaining({ reason: 'demo workspace seeded' }) });
  }, 300_000);
});
