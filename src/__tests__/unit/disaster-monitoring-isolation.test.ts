import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * feature-plan-disaster-restore.md §6.8 / approved detail D7, fix round 1 FR3: the disaster checks are the lifecycle
 * cron's own isolated step. A throw inside the sync → `runDisasterMonitoring` returns `{ error: true }` and raises
 * `rebuild-watch-check-failed` (best effort); the cron continues to signup maintenance and the digest.
 */

const h = vi.hoisted(() => ({ raised: [] as Array<{ kind: string }>, lockedCalls: 0, order: [] as string[] }));
vi.mock('server-only', () => ({}));
vi.mock('@/db/control-plane/locked', () => ({
  withLockedPool: async (fn: (db: unknown) => unknown) => {
    h.lockedCalls++;
    if (h.lockedCalls === 1) throw new Error('connect ECONNREFUSED'); // the facts read fails
    return fn({});
  },
}));
vi.mock('@/lib/tenant/lifecycle-store', () => ({
  raiseAlert: async (_db: unknown, a: { kind: string }) => { h.raised.push(a); return { opened: true }; },
  resolveAlert: async () => {},
  resolveAlertsByKindPrefix: async () => {},
}));

afterEach(() => { vi.unstubAllEnvs(); h.raised = []; h.lockedCalls = 0; h.order = []; });

describe('FR3: the disaster step is isolated', () => {
  it('a throwing sync → { error: true } and rebuild-watch-check-failed raised; it never throws', async () => {
    vi.stubEnv('BACKUPS_EXPECTED', '1');
    const { runDisasterMonitoring } = await import('@/lib/tenant/disaster-status');
    await expect(runDisasterMonitoring(new Date())).resolves.toEqual({ error: true });
    expect(h.raised.map((a) => a.kind)).toEqual(['rebuild-watch-check-failed']);
  });

  it('the lifecycle cron continues past a failing disaster step: backup → disaster → maintenance → digest, and reports it', async () => {
    vi.resetModules();
    vi.doMock('@/lib/cron/run-cron', () => ({ runCron: async (_r: unknown, _n: string, work: () => Promise<Record<string, unknown>>) => Response.json(await work()) }));
    vi.doMock('@/lib/tenant/lifecycle-runner', () => ({ runLifecycleCron: async () => ({ results: [], candidates: 0, incomplete: false }) }));
    vi.doMock('@/lib/signup/maintenance', () => ({ runSignupMaintenance: async () => { h.order.push('maintenance'); return {}; } }));
    vi.doMock('@/lib/tenant/ops-digest', () => ({ sendOpsDigest: async () => { h.order.push('digest'); return 'sent'; } }));
    vi.doMock('@/lib/tenant/backup-status', () => ({ runBackupMonitoring: async () => { h.order.push('backup'); return { synced: true, findings: 0 }; } }));
    vi.doMock('@/lib/tenant/disaster-status', () => ({ runDisasterMonitoring: async () => { h.order.push('disaster'); return { error: true }; } }));
    vi.doMock('@/db/control-plane/locked', () => ({ withLockedPool: async () => [] }));
    try {
      const { GET } = await import('@/app/api/cron/tenant-lifecycle/route');
      const { NextRequest } = await import('next/server');
      const res = await GET(new NextRequest('https://cadenzpoint.com/api/cron/tenant-lifecycle'));
      const body = await res.json();
      expect(h.order).toEqual(['backup', 'disaster', 'maintenance', 'digest']);
      expect(body.disaster).toEqual({ error: true });
    } finally {
      for (const m of ['@/lib/cron/run-cron', '@/lib/tenant/lifecycle-runner', '@/lib/signup/maintenance', '@/lib/tenant/ops-digest', '@/lib/tenant/backup-status', '@/lib/tenant/disaster-status', '@/db/control-plane/locked']) vi.doUnmock(m);
      vi.resetModules();
    }
  });
});
