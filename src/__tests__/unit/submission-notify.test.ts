import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import path from 'path';

/**
 * Certified outputs fix round 1, F15: a re-routed "waiting for approval" email prints the timesheet's real submission
 * time (not the moment it was re-routed); the dead CLIN-only getSupervisedEmployeeIds is gone; stale usage lines fixed.
 */

vi.mock('server-only', () => ({}));
vi.mock('@/db', async () => {
  const { createFakeControlDb } = await import('../helpers/fake-control-db');
  const db = createFakeControlDb();
  return { getDb: async () => db, __db: db };
});
const sent = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('@/lib/email/send', () => ({ sendTimesheetSubmittedEmail: vi.fn(async (d: Record<string, unknown>) => { sent.push(d); return { ok: true }; }) }));
vi.mock('@/lib/email/schedule', () => ({ scheduleEmail: (_n: string, fn: () => Promise<void>) => fn() }));
vi.mock('@/lib/tenant/context', () => ({ getTenantSlug: async () => 'acme' }));
vi.mock('@/server/internal/workspace-settings', () => ({ getWorkspaceTimezone: async () => 'UTC' }));
vi.mock('@/server/internal/notifications', () => ({ isNotificationEnabled: async () => true }));
vi.mock('@/server/internal/pay-period-config', () => ({ existingPeriodLength: async () => 15 }));

import * as dbModule from '@/db';
import { timesheetPeriods, users } from '@/db/schema';
import type { FakeControlDb } from '../helpers/fake-control-db';
import { notifyReroutedApprovals } from '@/server/internal/submission-notify';

const db = (dbModule as unknown as { __db: FakeControlDb }).__db;
const ROOT = path.resolve(__dirname, '../../..');
beforeEach(() => { db.reset(); sent.length = 0; vi.useRealTimers(); });

describe('F15', () => {
  it('a re-routed email shows the period\'s submitted_at, not the re-route time', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-25T18:00:00Z'), toFake: ['Date'] });
    db.onSelect(timesheetPeriods, [{ id: 'p1', periodStart: '2026-10-01', periodNumDays: 15, submittedAt: new Date('2026-10-16T13:05:00Z') }]);
    db.onSelect(users, [{ id: 'emp', role: 'employee', isActive: true, approverId: null }, { id: 'adm', role: 'admin', isActive: true, approverId: null }]);
    db.onSelect(users, [{ fullName: 'Pat Doe', email: 'pat@x' }]);
    db.onSelect(users, [{ id: 'adm', fullName: 'Ann Admin', email: 'ann@x' }]);
    await notifyReroutedApprovals([{ periodId: 'p1', userId: 'emp', recipients: ['adm'], designeeLost: false }]);
    expect(sent).toEqual([expect.objectContaining({ supervisorEmail: 'ann@x', submittedAt: expect.stringMatching(/^Oct 16, 2026 1:05 PM/) })]);
  });

  it('the dead CLIN-only getSupervisedEmployeeIds is gone; usage lines name the npm scripts', () => {
    expect(readFileSync(path.join(ROOT, 'src/server/internal/supervisor-scope.ts'), 'utf8')).not.toMatch(/getSupervisedEmployeeIds/);
    expect(readFileSync(path.join(ROOT, 'src/__tests__/integration/charge-code-actions.test.ts'), 'utf8')).not.toMatch(/getSupervisedEmployeeIds/);
    const seedDemo = readFileSync(path.join(ROOT, 'scripts/seed-demo.ts'), 'utf8');
    expect(seedDemo).not.toMatch(/npx tsx scripts\/seed-demo\.ts|Usage: tsx scripts\/seed-demo\.ts/);
    expect(seedDemo).toMatch(/npm run seed:demo -- <slug>/);
    if (existsSync(path.join(ROOT, 'feature-plan-production-deploy.md'))) {
      expect(readFileSync(path.join(ROOT, 'feature-plan-production-deploy.md'), 'utf8')).not.toMatch(/npx tsx scripts\/seed-(full|demo)\.ts/);
    }
  });
});
