import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import postgres from 'postgres';

/**
 * feature-plan-database-backups.md §11 S21 (the ordered locks, the lock factory's loss detection) and S23 (migrate-all
 * with nothing pending). Real Postgres; a scratch control plane (G2); migrate-all's migrations are fakes, so no real
 * database is ever migrated.
 */

import { BACKUP_LOCK_KEY, MIGRATE_RUN_LOCK_KEY } from '@/lib/tenant/backup-locks';
import { acquireLock, probeClient } from '../../../scripts/backup/lib/locks';
import { isAdvisoryLockHeld, waitForLock } from '../../../scripts/backup/lib/backup-wait';
import { runMigrateAll, type MigrateAllDeps } from '../../../scripts/lib/migrate-all-run';
import { createScratchDb, dropScratchDb, lockHolderPid, SERVER_URL, sleep, terminate, trackUncaught, waitUntil } from './backup-helpers';

const FAST = { heartbeatMs: 100, heartbeatTimeoutMs: 300 };

describe.skipIf(!SERVER_URL)('S21: the ordered locks', () => {
  let cp: { name: string; url: string };
  beforeAll(async () => { cp = await createScratchDb('cp'); });
  afterAll(async () => { if (cp) await dropScratchDb(cp.name); });

  it('isAdvisoryLockHeld reads pg_locks without taking the lock', async () => {
    const holder = await acquireLock(cp.url, BACKUP_LOCK_KEY);
    const probe = probeClient(cp.url);
    try {
      expect(await isAdvisoryLockHeld(probe, BACKUP_LOCK_KEY)).toBe(true);
      const [{ pid }] = await probe<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      const mine = await probe`SELECT 1 FROM pg_locks WHERE pid = ${pid} AND locktype = 'advisory'`;
      expect(mine.length).toBe(0);
      expect(await isAdvisoryLockHeld(probe, MIGRATE_RUN_LOCK_KEY)).toBe(false);
      await holder!.release();
      expect(await isAdvisoryLockHeld(probe, BACKUP_LOCK_KEY)).toBe(false);
    } finally {
      await probe.end();
    }
  });

  it('a second try-lock is refused while the first holds it; free again after release', async () => {
    const a = await acquireLock(cp.url, BACKUP_LOCK_KEY);
    expect(a).not.toBeNull();
    expect(await acquireLock(cp.url, BACKUP_LOCK_KEY)).toBeNull();
    await a!.release();
    const b = await acquireLock(cp.url, BACKUP_LOCK_KEY);
    expect(b).not.toBeNull();
    await b!.release();
  });

  it('lock loss: pg_terminate_backend on the lock session → onLost, with no uncaught exception', async () => {
    const t = trackUncaught();
    try {
      const lock = (await acquireLock(cp.url, BACKUP_LOCK_KEY, { timing: FAST }))!;
      const lost = vi.fn();
      lock.onLost(lost);
      const pid = await lockHolderPid(cp.url, BACKUP_LOCK_KEY);
      await terminate(cp.url, pid!);
      await waitUntil(() => lost.mock.calls.length === 1, 5_000);
      expect(lock.lost).toBe(true);
      await sleep(400); // further heartbeats must not touch the dead handle
      await lock.release();
      expect(t.count()).toBe(0);
      const again = await acquireLock(cp.url, BACKUP_LOCK_KEY);
      expect(again).not.toBeNull(); // the session ended, so the lock is free
      await again!.release();
    } finally {
      t.stop();
    }
  });

  it('a heartbeat that hangs → lock-lost after the heartbeat timeout', async () => {
    const lock = (await acquireLock(cp.url, BACKUP_LOCK_KEY, { timing: FAST, heartbeat: () => new Promise<boolean>(() => {}) }))!;
    const started = Date.now();
    await waitUntil(() => lock.lost, 5_000, 20);
    expect(Date.now() - started).toBeGreaterThanOrEqual(FAST.heartbeatTimeoutMs);
    await lock.release();
  });

  it('waitForLock returns free once the holder releases, or times out', async () => {
    const holder = (await acquireLock(cp.url, BACKUP_LOCK_KEY))!;
    const probe = probeClient(cp.url);
    try {
      const t0 = Date.now();
      expect(await waitForLock(probe, BACKUP_LOCK_KEY, { sleep, now: Date.now, maxMs: 250, pollMs: 50 })).toMatchObject({ free: false });
      expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
      setTimeout(() => void holder.release(), 150);
      expect(await waitForLock(probe, BACKUP_LOCK_KEY, { sleep, now: Date.now, maxMs: 5_000, pollMs: 50 })).toMatchObject({ free: true });
    } finally {
      await probe.end();
    }
  });

  describe('migrate-all', () => {
    const rows = [
      { slug: 'test-lc-a', status: 'active', dbUrlEncrypted: 'postgres://fake/a', neonProjectId: null },
      { slug: 'test-lc-b', status: 'active', dbUrlEncrypted: 'postgres://fake/b', neonProjectId: null },
      { slug: 'test-lc-c', status: 'active', dbUrlEncrypted: 'postgres://fake/c', neonProjectId: null },
    ];
    function deps(o: { pending?: number | 'error'; migrateMs?: number; waitMaxMs?: number } = {}) {
      const logs: string[] = [];
      const migrated: string[] = [];
      let controlMigrated = false;
      const d: MigrateAllDeps = {
        controlUrl: cp.url,
        log: (l) => logs.push(l),
        error: (l) => logs.push(l),
        redact: (m) => m,
        controlPending: async () => 0,
        migrateControl: async () => { controlMigrated = true; },
        listTenants: async () => rows,
        decryptUrl: (e) => e,
        tenant: {
          pendingCount: vi.fn(async () => { if (o.pending === 'error') throw new Error('ECONNREFUSED'); return o.pending ?? 1; }),
          migrate: vi.fn(async (url: string) => { await sleep(o.migrateMs ?? 0); migrated.push(url); }),
          confirmedAbsent: vi.fn(async () => ({ absent: false })),
          redact: (m) => m,
        },
        lock: { timing: FAST, waitMaxMs: o.waitMaxMs ?? 400, pollMs: 50, sleep },
      };
      return { d, logs, migrated, controlMigrated: () => controlMigrated };
    }

    it('with the backup lock held: waits, then exits 1 after the (shortened) limit with nothing applied', async () => {
      const backup = (await acquireLock(cp.url, BACKUP_LOCK_KEY))!;
      try {
        const { d, logs, migrated, controlMigrated } = deps();
        expect(await runMigrateAll({ check: false, concurrency: 2 }, d)).toBe(1);
        expect(logs).toContain('Waiting for the backup run to finish…');
        expect(logs).toContain('✗ A backup run is still active. Re-run deploy-prod later; nothing was changed.');
        expect(migrated).toEqual([]);
        expect(controlMigrated()).toBe(false);
        const probe = probeClient(cp.url);
        expect(await isAdvisoryLockHeld(probe, MIGRATE_RUN_LOCK_KEY)).toBe(false); // released while waiting
        await probe.end();
      } finally {
        await backup.release();
      }
    });

    it('proceeds once the backup run ends during the wait, holding MIGRATE_RUN_LOCK_KEY while it migrates', async () => {
      const backup = (await acquireLock(cp.url, BACKUP_LOCK_KEY))!;
      const { d, migrated, logs } = deps({ waitMaxMs: 5_000, migrateMs: 50 });
      const probe = probeClient(cp.url);
      let sawMigrateLock = false;
      (d.tenant.migrate as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
        sawMigrateLock ||= await isAdvisoryLockHeld(probe, MIGRATE_RUN_LOCK_KEY);
        migrated.push(url);
      });
      setTimeout(() => void backup.release(), 200);
      expect(await runMigrateAll({ check: false, concurrency: 1 }, d)).toBe(0);
      expect(logs).toContain('Waiting for the backup run to finish…');
      expect(migrated).toEqual(['postgres://fake/a', 'postgres://fake/b', 'postgres://fake/c']);
      expect(sawMigrateLock).toBe(true);
      expect(await isAdvisoryLockHeld(probe, MIGRATE_RUN_LOCK_KEY)).toBe(false);
      await probe.end();
    });

    it('--check never waits, even with the backup lock held', async () => {
      const backup = (await acquireLock(cp.url, BACKUP_LOCK_KEY))!;
      try {
        const { d, logs } = deps({ waitMaxMs: 60_000 });
        const t0 = Date.now();
        expect(await runMigrateAll({ check: true, concurrency: 2 }, d)).toBe(2);
        expect(Date.now() - t0).toBeLessThan(3_000);
        expect(logs).not.toContain('Waiting for the backup run to finish…');
      } finally {
        await backup.release();
      }
    });

    it('S23: nothing pending → the handshake is skipped (never waits, even with the backup lock held)', async () => {
      const backup = (await acquireLock(cp.url, BACKUP_LOCK_KEY))!;
      try {
        const { d, logs } = deps({ pending: 0, waitMaxMs: 60_000 });
        const connect = vi.fn(() => { throw new Error('the lock must not be touched'); });
        d.lock = { ...d.lock, connect };
        expect(await runMigrateAll({ check: false, concurrency: 2 }, d)).toBe(0);
        expect(connect).not.toHaveBeenCalled();
        expect(logs).not.toContain('Waiting for the backup run to finish…');
      } finally {
        await backup.release();
      }
    });

    it('a pending count that errors → the handshake runs (fail towards waiting)', async () => {
      const backup = (await acquireLock(cp.url, BACKUP_LOCK_KEY))!;
      try {
        const { d, logs } = deps({ pending: 'error' });
        expect(await runMigrateAll({ check: false, concurrency: 2 }, d)).toBe(1);
        expect(logs).toContain('Waiting for the backup run to finish…');
      } finally {
        await backup.release();
      }
    });

    it('a fresh control plane (no tenants table yet): handshake runs, the control plane migrates, then tenants are listed', async () => {
      const { d, migrated, controlMigrated } = deps({ pending: 0 });
      let calls = 0;
      d.listTenants = async () => { calls++; if (!controlMigrated()) throw new Error('relation "tenants" does not exist'); return rows; };
      const connect = vi.fn((url: string, o: never) => postgres(url, o));
      d.lock = { ...d.lock, connect: connect as never };
      expect(await runMigrateAll({ check: false, concurrency: 2 }, d)).toBe(0);
      expect(calls).toBe(2);
      expect(connect).toHaveBeenCalled();
      expect(migrated.length).toBe(3);
    });

    it('lock loss mid-run → stops before the next database, exit 1, no uncaught exception', async () => {
      const t = trackUncaught();
      try {
        const { d, migrated, logs } = deps({ migrateMs: 400 });
        const run = runMigrateAll({ check: false, concurrency: 1 }, d);
        await waitUntil(async () => (await lockHolderPid(cp.url, MIGRATE_RUN_LOCK_KEY)) !== null, 5_000);
        await waitUntil(() => (d.tenant.migrate as ReturnType<typeof vi.fn>).mock.calls.length >= 1, 5_000);
        await terminate(cp.url, (await lockHolderPid(cp.url, MIGRATE_RUN_LOCK_KEY))!);
        expect(await run).toBe(1);
        expect(migrated.length).toBeLessThan(3);
        expect(logs.some((l) => l.includes('migration run lock was lost'))).toBe(true);
        expect(t.count()).toBe(0);
      } finally {
        t.stop();
      }
    });
  });
});

describe.skipIf(!SERVER_URL)('S21: a postgres.js reserved handle (the documented hazard the factory avoids)', () => {
  it('the factory never queries a closed handle: repeated heartbeats after a kill raise nothing', async () => {
    const cp = await createScratchDb('cp');
    const t = trackUncaught();
    try {
      const lock = (await acquireLock(cp.url, MIGRATE_RUN_LOCK_KEY, { timing: { heartbeatMs: 30, heartbeatTimeoutMs: 200 } }))!;
      const admin = postgres(cp.url, { max: 1 });
      const [{ pid }] = await admin<{ pid: number }[]>`SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND objid = ${MIGRATE_RUN_LOCK_KEY} AND granted`;
      await admin`SELECT pg_terminate_backend(${pid})`;
      await admin.end();
      await waitUntil(() => lock.lost, 5_000, 10);
      await sleep(300);
      await lock.release();
      expect(t.count()).toBe(0);
    } finally {
      t.stop();
      await dropScratchDb(cp.name);
    }
  });
});
