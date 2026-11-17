import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * feature-plan-database-backups.md §11 U5 (lock parts): every lock connection goes to the DIRECT host, with
 * max_lifetime/idle_timeout null and a reserved connection; the four keys are distinct from each other and from
 * MIGRATION_LOCK_KEY.
 */
import { AUDIT_LOCK_KEY, BACKUP_LOCK_KEY, MIGRATE_RUN_LOCK_KEY, RESTORE_TEST_LOCK_KEY } from '@/lib/tenant/backup-locks';
import { acquireLock, probeClient, splitKey, type Connect } from '../../../scripts/backup/lib/locks';

const POOLED = 'postgresql://owner:pw@ep-cp-1-pooler.c-2.us-east-1.aws.neon.tech/control?sslmode=require&channel_binding=require';
const ROOT = path.resolve(__dirname, '../../..');

function fakeConnect() {
  const calls: Array<{ url: string; options: Record<string, unknown> }> = [];
  const reserveCalls = vi.fn();
  const connect: Connect = ((url: string, options: Record<string, unknown>) => {
    calls.push({ url, options });
    const tagged = Object.assign(async () => [{ got: true }], { release: () => {} });
    return { reserve: async () => { reserveCalls(); return tagged; }, end: async () => {} } as never;
  }) as never;
  return { connect, calls, reserveCalls };
}

describe('U5: lock connections', () => {
  it('acquireLock and probeClient connect to the direct host, query reduced to sslmode, never recycled', async () => {
    const f = fakeConnect();
    const lock = await acquireLock(POOLED, BACKUP_LOCK_KEY, { connect: f.connect, timing: { heartbeatMs: 60_000, heartbeatTimeoutMs: 15_000 } });
    probeClient(POOLED, f.connect);
    expect(f.calls.map((c) => c.url)).toEqual([
      'postgresql://owner:pw@ep-cp-1.c-2.us-east-1.aws.neon.tech/control?sslmode=require',
      'postgresql://owner:pw@ep-cp-1.c-2.us-east-1.aws.neon.tech/control?sslmode=require',
    ]);
    for (const c of f.calls) {
      expect(c.options).toMatchObject({ max: 1, max_lifetime: null, idle_timeout: null });
      expect('idle_timeout' in c.options && 'max_lifetime' in c.options).toBe(true);
    }
    expect(f.reserveCalls).toHaveBeenCalledTimes(1);
    await lock!.release();
  });

  it('the four lock keys are distinct from each other and from MIGRATION_LOCK_KEY', () => {
    const migrationKey = Number(/const MIGRATION_LOCK_KEY = ([\d_]+);/.exec(readFileSync(path.join(ROOT, 'src/lib/tenant/migrate-tenant.ts'), 'utf8'))![1].replace(/_/g, ''));
    expect(migrationKey).toBe(728402113);
    const keys = [BACKUP_LOCK_KEY, AUDIT_LOCK_KEY, RESTORE_TEST_LOCK_KEY, MIGRATE_RUN_LOCK_KEY, migrationKey];
    expect(new Set(keys).size).toBe(5);
    expect(splitKey(BACKUP_LOCK_KEY)).toEqual({ hi: 0, lo: 728402201 });
  });

  it('migrate-all imports the handshake (the deploy-time wait runs through it)', () => {
    const src = readFileSync(path.join(ROOT, 'scripts/migrate-all.ts'), 'utf8');
    expect(src).toContain("from './lib/migrate-all-run'");
    expect(src).toMatch(/printTargetBanner\(\)/);
  });
});
