import { describe, it, expect, vi } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { runMigrateAll, type MigrateAllDeps, type DisasterActionInput, type MigrateTenantRow } from '../../../scripts/lib/migrate-all-run';
import { migrateOneTenant } from '../../../scripts/lib/tenant-migration';
import { hasLiveProof, needsMigratedRow, NO_FACTS, SKIPPABLE_PROOFS, DECISIVE_PROOFS, type TenantDisasterFacts } from '../../../scripts/backup/lib/disaster-proofs';

/**
 * feature-plan-disaster-restore.md §11 D5: `--skip-lost` (§6.0) with fake tenants and fake records. Nothing here takes the
 * migrate lock (nothing is pending, or the test proves it isn't touched); the lock-holding paths are in R7.
 */

const ROOT = path.resolve(__dirname, '../../..');
const T = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const LOST: MigrateTenantRow = { id: T(1), slug: 'test-dr-lost', status: 'active', dbUrlEncrypted: 'postgres://fake/lost', neonProjectId: 'p-lost' };
const LIVE: MigrateTenantRow = { id: T(2), slug: 'test-dr-live', status: 'active', dbUrlEncrypted: 'postgres://fake/live', neonProjectId: 'p-live' };
const t0 = new Date('2026-11-10T12:00:00Z');
const later = (h: number) => new Date(t0.getTime() + h * 3600_000);
const facts = (o: Partial<TenantDisasterFacts>): TenantDisasterFacts => ({ ...NO_FACTS, ...o });
const proof = (status: string, at = t0) => ({ status, at });

function setup(o: {
  rows?: MigrateTenantRow[];
  facts?: Record<string, TenantDisasterFacts>;
  /** URLs whose count throws; a number = throw that many times, then 0. */
  lost?: Record<string, true | number>;
  append?: (row: DisasterActionInput) => Promise<void>;
  readFacts?: () => Promise<Map<string, TenantDisasterFacts>>;
  migrateThrows?: boolean;
} = {}) {
  const logs: string[] = [];
  const appended: DisasterActionInput[] = [];
  const throwsLeft = new Map(Object.entries(o.lost ?? {}).map(([k, v]) => [k, v === true ? Infinity : v]));
  const d: MigrateAllDeps = {
    controlUrl: 'postgres://never-used/cp',
    log: (l) => logs.push(l),
    error: (l) => logs.push(l),
    redact: (m) => m,
    controlPending: async () => 0,
    migrateControl: async () => {},
    listTenants: async () => o.rows ?? [LOST, LIVE],
    decryptUrl: (e) => e,
    disaster: {
      runId: 'migrate-test',
      readFacts: o.readFacts ?? (async () => new Map(Object.entries(o.facts ?? {}))),
      append: vi.fn(o.append ?? (async (row: DisasterActionInput) => { appended.push(row); })),
    },
    tenant: {
      pendingCount: vi.fn(async (url: string) => {
        const left = throwsLeft.get(url) ?? 0;
        if (left > 0) {
          throwsLeft.set(url, left - 1);
          throw Object.assign(new Error('password authentication failed for user "x"'), { code: '28P01', name: 'PostgresError' });
        }
        return 0;
      }),
      migrate: vi.fn(async () => { if (o.migrateThrows) throw new Error('migration 0042 failed'); }),
      confirmedAbsent: vi.fn(async () => ({ absent: false as const })),
      redact: (m) => m,
    },
    // Any lock attempt fails the test: these cases never pend.
    lock: { connect: (() => { throw new Error('the migrate lock must not be touched'); }) as never },
  };
  return { d, logs, appended };
}

describe('D5: the proof rules (disaster-proofs.ts)', () => {
  it('every skippable status is live at any age; reachable-again and refused:reachable are decisive but not skippable', () => {
    for (const s of SKIPPABLE_PROOFS) expect(hasLiveProof(facts({ proof: proof(s, new Date('2020-01-01')) })), s).toBe(true);
    expect(hasLiveProof(facts({ proof: proof('reachable-again') }))).toBe(false);
    expect(hasLiveProof(facts({ proof: proof('refused:reachable') }))).toBe(false);
    expect(DECISIVE_PROOFS).toEqual(expect.arrayContaining(['reachable-again', 'refused:reachable', ...SKIPPABLE_PROOFS]));
    for (const transient of ['refused:proof-failed', 'refused:network-unproven', 'refused:original-exists', 'refused:recoverable', 'rehearse-ok']) {
      expect(DECISIVE_PROOFS as readonly string[]).not.toContain(transient);
    }
    expect(hasLiveProof(NO_FACTS)).toBe(false);
  });

  it('a newer linked row or a newer 3b ok backup ends the proof; an older one does not', () => {
    expect(hasLiveProof(facts({ proof: proof('gone'), linkedAt: later(1) }))).toBe(false);
    expect(hasLiveProof(facts({ proof: proof('gone'), lastOkAt: later(1) }))).toBe(false);
    expect(hasLiveProof(facts({ proof: proof('gone'), linkedAt: later(-1), lastOkAt: later(-1) }))).toBe(true);
  });

  it('a migrated row is due after a newer skip or linked row, and not otherwise', () => {
    expect(needsMigratedRow(NO_FACTS)).toBe(false);
    expect(needsMigratedRow(facts({ skippedAt: t0 }))).toBe(true);
    expect(needsMigratedRow(facts({ linkedAt: t0 }))).toBe(true);
    expect(needsMigratedRow(facts({ skippedAt: t0, migratedAt: later(1) }))).toBe(false);
    expect(needsMigratedRow(facts({ skippedAt: t0, linkedAt: later(2), migratedAt: later(1) }))).toBe(true);
  });
});

describe('D5: migrateOneTenant\'s skip hook', () => {
  it('runs only when pendingCount throws; a migrate() failure is FAILED, never skipped', async () => {
    const onCountFailed = vi.fn(async () => ({ outcome: 'skipped' as const, detail: 'x' }));
    const base = { pendingCount: async () => 1, migrate: async () => { throw new Error('boom'); }, confirmedAbsent: async () => ({ absent: false as const }), redact: (m: string) => m, onCountFailed };
    expect((await migrateOneTenant(LOST, 'u', false, base)).outcome).toBe('FAILED');
    expect(onCountFailed).not.toHaveBeenCalled();
    const r = await migrateOneTenant(LOST, 'u', false, { ...base, pendingCount: async () => { throw new Error('28P01'); } });
    expect(r).toEqual({ outcome: 'skipped', detail: 'x' });
  });
});

describe('D5: runMigrateAll --skip-lost', () => {
  it('proven and unreachable → skipped by uuid (no slug anywhere), skip row recorded, exit 0; step 0 excludes it (no lock)', async () => {
    const { d, logs, appended } = setup({ facts: { [T(1)]: facts({ proof: proof('gone') }) }, lost: { 'postgres://fake/lost': true } });
    expect(await runMigrateAll({ check: false, concurrency: 2, skipLost: true }, d)).toBe(0);
    const row = logs.find((l) => l.includes(T(1)))!;
    expect(row).toContain('skipped (proven lost, awaiting rebuild)');
    expect(logs.join('\n')).not.toContain('test-dr-lost');
    expect(logs).toContain('Skipping workspaces the disaster button proved lost (--skip-lost).');
    expect(appended).toContainEqual({ tenantId: T(1), kind: 'skip', status: 'skipped', oldProjectId: 'p-lost' });
  });

  it('a deletion-due proof (status gone, detail deletion-due) is skipped like any other', async () => {
    // The detail never changes the status; the facts carry the status only.
    const { d } = setup({ facts: { [T(1)]: facts({ proof: proof('gone') }) }, lost: { 'postgres://fake/lost': true } });
    expect(await runMigrateAll({ check: false, concurrency: 1, skipLost: true }, d)).toBe(0);
  });

  it('the skip row\'s insert failing → FAILED, exit 1', async () => {
    const { d, logs } = setup({ facts: { [T(1)]: facts({ proof: proof('gone') }) }, lost: { 'postgres://fake/lost': true }, append: async () => { throw new Error('insert failed'); } });
    expect(await runMigrateAll({ check: false, concurrency: 1, skipLost: true }, d)).toBe(1);
    expect(logs.find((l) => l.includes(T(1)))).toContain('FAILED: skip not recorded');
  });

  it('without the flag a proven-lost tenant fails as today, and nothing is recorded for it', async () => {
    const { d, appended } = setup({ facts: { [T(1)]: facts({ proof: proof('gone') }) }, lost: { 'postgres://fake/lost': true } });
    d.lock = undefined; // the failing count forces the handshake; give it nothing to lock with
    d.controlUrl = 'postgres://127.0.0.1:1/none';
    expect(await runMigrateAll({ check: false, concurrency: 1 }, d)).toBe(1);
    expect(appended.filter((a) => a.tenantId === T(1))).toEqual([]);
  });

  it('unproven and unreachable → FAILED; linked since → not skipped; a 3b ok after the proof → not skipped', async () => {
    for (const f of [NO_FACTS, facts({ proof: proof('gone'), linkedAt: later(1) }), facts({ proof: proof('gone'), lastOkAt: later(1) }), facts({ proof: proof('refused:proof-failed') })]) {
      // --check applies the same skip rules without the lock (a normal run would pend and lock: R7 covers that).
      const { d, logs } = setup({ rows: [LOST], facts: { [T(1)]: f }, lost: { 'postgres://fake/lost': true } });
      expect(await runMigrateAll({ check: true, concurrency: 1, skipLost: true }, d)).toBe(1);
      expect(logs.find((l) => l.includes('test-dr-lost'))).toContain('FAILED');
      expect(logs.join('\n')).not.toContain('skipped (proven lost');
    }
  });

  it('proven but reachable now → migrated normally, reachable-again recorded (so the proof stops counting)', async () => {
    const { d, appended, logs } = setup({ facts: { [T(1)]: facts({ proof: proof('observed-unreachable') }) } });
    expect(await runMigrateAll({ check: false, concurrency: 1, skipLost: true }, d)).toBe(0);
    expect(logs.find((l) => l.includes('test-dr-lost'))).toContain('up-to-date');
    expect(appended).toContainEqual({ tenantId: T(1), kind: 'proof', status: 'reachable-again', oldProjectId: 'p-lost' });
  });

  it('every normal run writes reachable-again, with or without the flag; a failed write → FAILED (D2)', async () => {
    const ok = setup({ facts: { [T(1)]: facts({ proof: proof('gone') }) } });
    expect(await runMigrateAll({ check: false, concurrency: 1 }, ok.d)).toBe(0);
    expect(ok.appended.map((a) => a.status)).toContain('reachable-again');
    const bad = setup({ facts: { [T(1)]: facts({ proof: proof('gone') }) }, append: async () => { throw new Error('insert failed'); } });
    expect(await runMigrateAll({ check: false, concurrency: 1 }, bad.d)).toBe(1);
    expect(bad.logs.find((l) => l.includes('test-dr-lost'))).toContain('reachable-again not recorded');
  });

  it('a migrated row is written after a skip or a rebuild; its failure is a warning only (D2)', async () => {
    const ok = setup({ facts: { [T(2)]: facts({ skippedAt: t0 }), [T(1)]: facts({ linkedAt: t0 }) } });
    expect(await runMigrateAll({ check: false, concurrency: 1 }, ok.d)).toBe(0);
    expect(ok.appended.filter((a) => a.status === 'migrated').map((a) => a.tenantId).sort()).toEqual([T(1), T(2)]);
    const bad = setup({ facts: { [T(2)]: facts({ skippedAt: t0 }) }, append: async () => { throw new Error('insert failed'); } });
    expect(await runMigrateAll({ check: false, concurrency: 1 }, bad.d)).toBe(0);
    expect(bad.logs.some((l) => l.includes('could not be written (warning only)'))).toBe(true);
  });

  it('a skipped tenant that reconnects in the pass (no lock held) → FAILED by uuid, exit 1, reachable-again written', async () => {
    const { d, logs, appended } = setup({ facts: { [T(1)]: facts({ proof: proof('gone') }) }, lost: { 'postgres://fake/lost': 1 } });
    expect(await runMigrateAll({ check: false, concurrency: 1, skipLost: true }, d)).toBe(1);
    expect(logs.find((l) => l.includes(T(1)))).toContain('FAILED: reachable again; re-run the deploy');
    expect(logs.join('\n')).not.toContain('test-dr-lost');
    expect(appended).toContainEqual({ tenantId: T(1), kind: 'proof', status: 'reachable-again', oldProjectId: 'p-lost' });
    expect(d.tenant.migrate).not.toHaveBeenCalledWith('postgres://fake/lost');
  });

  it('--check skips on the same rules and writes nothing (D1); exit 0 when the rest is current', async () => {
    const { d, logs } = setup({ facts: { [T(1)]: facts({ proof: proof('refused:credentials') }) }, lost: { 'postgres://fake/lost': true } });
    expect(await runMigrateAll({ check: true, concurrency: 1, skipLost: true }, d)).toBe(0);
    expect(d.disaster!.append).not.toHaveBeenCalled();
    expect(logs.find((l) => l.includes(T(1)))).toContain('skipped (proven lost');
  });

  it('a facts read error stops the run (exit 1) before anything is migrated', async () => {
    const { d } = setup({ readFacts: async () => { throw new Error('connection refused'); } });
    expect(await runMigrateAll({ check: false, concurrency: 1, skipLost: true }, d)).toBe(1);
    expect(d.tenant.migrate).not.toHaveBeenCalled();
  });
});

describe('D5: deploy-prod.yml passes --skip-lost only when the boolean is true', () => {
  const wf = parse(readFileSync(path.join(ROOT, '.github/workflows/deploy-prod.yml'), 'utf8')) as { on: { workflow_dispatch: { inputs: Record<string, { type?: string; default?: unknown }> } }; jobs: { deploy: { steps: Array<{ name?: string; run?: string; env?: Record<string, string> }> } } };
  const steps = wf.jobs.deploy.steps;

  it('declares the boolean input, default false', () => {
    expect(wf.on.workflow_dispatch.inputs.skip_lost_workspaces).toMatchObject({ type: 'boolean', default: false });
  });

  for (const script of ['db:migrate:all', 'db:migrate:check']) {
    it(`${script}: the run block with SKIP_LOST=true passes "-- --skip-lost"; false (or anything else) never does`, () => {
      const step = steps.find((s) => s.run?.includes(`npm run ${script}`))!;
      expect(step.env?.SKIP_LOST).toBe('${{ inputs.skip_lost_workspaces == true }}');
      const dir = mkdtempSync(path.join(tmpdir(), 'dr-npm-'));
      writeFileSync(path.join(dir, 'npm'), '#!/bin/bash\necho "npm $*" >> "$NPM_LOG"\n');
      chmodSync(path.join(dir, 'npm'), 0o755);
      const block = path.join(dir, 'block.sh');
      writeFileSync(block, step.run!);
      for (const [value, expected] of [['true', `npm run ${script} -- --skip-lost`], ['false', `npm run ${script}`], ['', `npm run ${script}`]] as const) {
        const log = path.join(dir, `log-${value || 'empty'}`);
        const r = spawnSync('bash', ['-e', block], { env: { PATH: `${dir}:${process.env.PATH}`, SKIP_LOST: value, NPM_LOG: log } as unknown as NodeJS.ProcessEnv, encoding: 'utf8' });
        expect(r.status).toBe(0);
        expect(readFileSync(log, 'utf8').trim()).toBe(expected);
      }
    });
  }
});

describe('fix round 1 (D5 additions)', () => {
  it('M01: the skippable proof statuses, pinned literally (refused:database-missing among them)', () => {
    expect([...SKIPPABLE_PROOFS]).toEqual(['gone', 'unreachable-4h', 'observed-unreachable', 'refused:credentials', 'refused:database-missing']);
    expect([...DECISIVE_PROOFS]).toEqual([...SKIPPABLE_PROOFS, 'reachable-again', 'refused:reachable']);
  });

  it('M20: without the flag nothing is skippable: --check prints the FAILED row by slug; a normal run counts it as pending and runs the handshake', async () => {
    const chk = setup({ facts: { [T(1)]: facts({ proof: proof('gone') }) }, lost: { 'postgres://fake/lost': true } });
    expect(await runMigrateAll({ check: true, concurrency: 1 }, chk.d)).toBe(1);
    expect(chk.logs.find((l) => l.includes('test-dr-lost'))).toContain('FAILED');
    expect(chk.logs.join('\n')).not.toContain(T(1));
    const run = setup({ facts: { [T(1)]: facts({ proof: proof('gone') }) }, lost: { 'postgres://fake/lost': true } });
    expect(await runMigrateAll({ check: false, concurrency: 1 }, run.d)).toBe(1);
    expect(run.logs.some((l) => l.startsWith('✗ could not take the migration run lock'))).toBe(true); // the handshake ran
  });
});
