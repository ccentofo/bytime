import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { controlDb } from '@/db/control-plane';
import { cronRuns, opsAlerts } from '@/db/control-plane/schema';
import { withLockedPool } from '@/db/control-plane/locked';
import { raiseAlert, resolveAlert } from '@/lib/tenant/lifecycle-store';
import { readCronState, readCronRuns } from '@/lib/cron/heartbeat';
import { runCron } from '@/lib/cron/run-cron';
import { cpReady } from './lifecycle-helpers';

/**
 * feature-plan-launch-blockers.md P6 §3 / §9 "Heartbeat" (database side): runCron writes the real cron_runs row at
 * start and on success; a probe writes nothing; the saved cursor reads back; raiseAlert reports `opened` only for a
 * new incident (what the immediate-email alerts rely on).
 *
 * Non-destructive by design — the integration control plane can be the developer's local one (with real demo
 * tenants registered): no cron_runs rows are deleted, no real cron runs, and the test alert uses a unique kind that
 * is resolved afterwards.
 */

const SECRET = 'heartbeat-test-secret';
const req = (q = '') => new NextRequest(`https://app.example.com/api/cron/notice-delivery${q}`, { headers: { 'x-cron-secret': SECRET } });
const row = async (name: string) => (await readCronRuns()).find((r) => r.name === name) ?? null;

describe.skipIf(!cpReady)('cron heartbeat (P6)', () => {
  let savedSecret: string | undefined;
  beforeEach(() => { savedSecret = process.env.CRON_SECRET; process.env.CRON_SECRET = SECRET; });
  afterEach(() => { process.env.CRON_SECRET = savedSecret; });

  it('a run writes cron_runs start + success with the summary (including the cursor)', async () => {
    const before = Date.now();
    const res = await runCron(req(), 'notice-delivery', async () => ({ message: 'test', cursor: 'zz-heartbeat-test', resumes: { 'zz-heartbeat-test': 'emp-7', 'zz-other': null } }), { maxRuntimeMinutes: 5 });
    expect(res.status).toBe(200);
    const r = await row('notice-delivery');
    expect(r!.lastStartedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(r!.lastSucceededAt!.getTime()).toBeGreaterThanOrEqual(r!.lastStartedAt!.getTime());
    expect(r!.lastSummary).toEqual({ message: 'test', cursor: 'zz-heartbeat-test', resumes: { 'zz-heartbeat-test': 'emp-7', 'zz-other': null } });
    expect(await readCronState('notice-delivery')).toEqual({ cursor: 'zz-heartbeat-test', resumes: { 'zz-heartbeat-test': 'emp-7', 'zz-other': null } });
  });

  it('audit R1: a summary written before R1 (single `resume`) is read as a one-entry resumes map', async () => {
    await runCron(req(), 'notice-delivery', async () => ({ message: 'test', cursor: 'zz-heartbeat-test', resume: { slug: 'zz-heartbeat-test', after: 'emp-7' } }), { maxRuntimeMinutes: 5 });
    expect(await readCronState('notice-delivery')).toEqual({ cursor: 'zz-heartbeat-test', resumes: { 'zz-heartbeat-test': 'emp-7' } });
  });

  it('a failed run advances last_started_at only', async () => {
    await runCron(req(), 'notice-delivery', async () => ({ ok: true }), { maxRuntimeMinutes: 5 });
    const ok = await row('notice-delivery');
    await new Promise((r) => setTimeout(r, 20));
    await expect(runCron(req(), 'notice-delivery', async () => { throw new Error('boom'); }, { maxRuntimeMinutes: 5 })).rejects.toThrow('boom');
    const failed = await row('notice-delivery');
    expect(failed!.lastStartedAt!.getTime()).toBeGreaterThan(ok!.lastStartedAt!.getTime());
    expect(failed!.lastSucceededAt!.getTime()).toBe(ok!.lastSucceededAt!.getTime());
  });

  it('?probe=1 writes nothing', async () => {
    await runCron(req(), 'notice-delivery', async () => ({ ok: true }), { maxRuntimeMinutes: 5 });
    const before = await row('notice-delivery');
    const res = await runCron(req('?probe=1'), 'notice-delivery', async () => { throw new Error('must not run'); }, { maxRuntimeMinutes: 5 });
    expect(await res.json()).toEqual({ probe: 'ok' });
    const after = await row('notice-delivery');
    expect(after!.lastStartedAt!.getTime()).toBe(before!.lastStartedAt!.getTime());
    expect(after!.lastSucceededAt!.getTime()).toBe(before!.lastSucceededAt!.getTime());
  });

  it('raiseAlert: opened for a new incident, not for a bump; a new incident after resolution opens again', async () => {
    const alert = { tenantId: null, kind: `test-hb-${crypto.randomBytes(4).toString('hex')}` };
    try {
      const now = new Date();
      expect(await withLockedPool((db) => raiseAlert(db, alert, now))).toEqual({ opened: true });
      expect(await withLockedPool((db) => raiseAlert(db, alert, now))).toEqual({ opened: false });
      await withLockedPool((db) => resolveAlert(db, alert, now));
      expect(await withLockedPool((db) => raiseAlert(db, alert, now))).toEqual({ opened: true });
    } finally {
      await withLockedPool((db) => resolveAlert(db, alert, new Date(), 'test cleanup'));
      const open = await controlDb.select().from(opsAlerts).where(and(eq(opsAlerts.kind, alert.kind), isNull(opsAlerts.resolvedAt)));
      expect(open).toEqual([]);
    }
  });

  it('the cron_runs table exists with the migration 0007 columns', async () => {
    await controlDb.select({ name: cronRuns.name, s: cronRuns.lastStartedAt, ok: cronRuns.lastSucceededAt, sum: cronRuns.lastSummary }).from(cronRuns).limit(1);
  });
});
