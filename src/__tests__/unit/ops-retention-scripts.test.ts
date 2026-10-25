import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * feature-plan-launch-blockers.md P6 / §9 "Retention" and "Ops": Neon history retention at create + backfill;
 * migrate-all's `deleting` handling; the founder-script target banner; the provision:tenant loopback guard; Sentry
 * environments.
 */

vi.mock('server-only', () => ({}));

import { createNeonDatabase, setNeonHistoryRetention, localDevAdminUrl } from '@/lib/tenant/neon';
import { TENANT_DB_HISTORY_RETENTION_SECONDS, tenantDbHistoryRetentionSeconds } from '@/lib/tenant/lifecycle-config';
import { runRetentionBackfill, type RetentionDeps } from '../../../scripts/lib/retention-backfill';
import { MIGRATABLE_TENANT_STATUSES, migrateOneTenant, isTenantDatabaseConfirmedAbsent, NEON_KEY_MISSING_NOTE, type TenantMigrationDeps, type AbsenceCheck } from '../../../scripts/lib/tenant-migration';
import { targetBanner, isLoopbackUrl, describeDatabaseUrl } from '../../../scripts/lib/target';
import { provisionWithoutNeonRefusal } from '../../../scripts/lib/provision-guard';
import { parseProvisionArgs, provisionRecordFailedMessage } from '../../../scripts/lib/provision-args';

const ROOT = path.resolve(__dirname, '../../..');
const ENV_KEYS = ['NEON_API_KEY', 'NEON_HISTORY_RETENTION_SECONDS', 'NEON_REGION_ID'] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.unstubAllGlobals();
});

/** A fetch stub answering Neon's create-project call; records request bodies. */
function stubNeonCreate() {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({
      project: { id: 'proj-1' },
      operations: [],
      connection_uris: [{
        connection_uri: 'postgresql://u:p@ep-x.us-east-1.aws.neon.tech/cp_acme?sslmode=require',
        connection_parameters: { host: 'ep-x.us-east-1.aws.neon.tech', pooler_host: 'ep-x-pooler.us-east-1.aws.neon.tech', database: 'cp_acme', role: 'u' },
      }],
    }), { status: 201 });
  }));
  return calls;
}

describe('Neon history retention (LB-D1)', () => {
  it('project creation sends history_retention_seconds = 7 days', async () => {
    process.env.NEON_API_KEY = 'test-key';
    const calls = stubNeonCreate();
    await createNeonDatabase('acme');
    const create = calls.find((c) => c.method === 'POST')!;
    expect((create.body as { project: { history_retention_seconds: number } }).project.history_retention_seconds).toBe(604_800);
    expect(TENANT_DB_HISTORY_RETENTION_SECONDS).toBe(604_800);
  });

  it('NEON_HISTORY_RETENTION_SECONDS overrides it (Free-plan staging org)', async () => {
    process.env.NEON_API_KEY = 'test-key';
    process.env.NEON_HISTORY_RETENTION_SECONDS = '21600';
    const calls = stubNeonCreate();
    await createNeonDatabase('acme');
    expect((calls.find((c) => c.method === 'POST')!.body as { project: { history_retention_seconds: number } }).project.history_retention_seconds).toBe(21600);
  });

  it('a set-but-invalid override throws instead of silently falling back', () => {
    process.env.NEON_HISTORY_RETENTION_SECONDS = '7d';
    expect(() => tenantDbHistoryRetentionSeconds()).toThrow(/whole number of seconds/);
  });

  it('audit A12: the override is bounded to 3600–604800 (0 would turn point-in-time restore off)', () => {
    for (const bad of ['0', '3599', '604801', '2592000']) {
      process.env.NEON_HISTORY_RETENTION_SECONDS = bad;
      expect(() => tenantDbHistoryRetentionSeconds(), bad).toThrow(/from 3600 to 604800/);
    }
    for (const good of ['3600', '21600', '604800']) {
      process.env.NEON_HISTORY_RETENTION_SECONDS = good;
      expect(tenantDbHistoryRetentionSeconds()).toBe(Number(good));
    }
  });

  it('the backfill PATCH sends project.history_retention_seconds', async () => {
    process.env.NEON_API_KEY = 'test-key';
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await setNeonHistoryRetention('proj-9', 604_800)).toBe('updated');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/projects\/proj-9$/);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ project: { history_retention_seconds: 604_800 } });
  });
});

describe('backfill:neon-retention', () => {
  function deps(o: { get?: RetentionDeps['get']; set?: RetentionDeps['set'] } = {}) {
    return {
      get: vi.fn<RetentionDeps['get']>(o.get ?? (async () => 86_400)),
      set: vi.fn<RetentionDeps['set']>(o.set ?? (async () => 'updated')),
      log: vi.fn<RetentionDeps['log']>(),
    };
  }
  const tenants = [
    { slug: 'acme', status: 'active', neonProjectId: 'p-acme' },
    { slug: 'beta', status: 'suspended', neonProjectId: 'p-beta' },
    { slug: 'local', status: 'active', neonProjectId: null },
    { slug: 'gone', status: 'deleted', neonProjectId: 'p-gone' },
  ];

  it('PATCHes every non-deleted tenant project with the target', async () => {
    const d = deps();
    const r = await runRetentionBackfill(tenants, 604_800, { check: false }, d);
    expect(d.set.mock.calls).toEqual([['p-acme', 604_800], ['p-beta', 604_800]]);
    expect(r.updated).toEqual(['acme', 'beta']);
    expect(r.failed).toEqual([]);
  });

  it('--check makes no PATCH calls and reports what would change', async () => {
    const d = deps({ get: async (id: string) => (id === 'p-acme' ? 604_800 : 86_400) });
    const r = await runRetentionBackfill(tenants, 604_800, { check: true }, d);
    expect(d.set).not.toHaveBeenCalled();
    expect(r.alreadyOk).toEqual(['acme']);
    expect(r.wouldUpdate).toEqual(['beta']);
  });

  it('tenants without neon_project_id are listed as needing manual action', async () => {
    const r = await runRetentionBackfill(tenants, 604_800, { check: false }, deps());
    expect(r.manual).toEqual(['local']);
  });

  it('one failure is listed (→ non-zero exit) and the others still run', async () => {
    const d = deps({ set: async (id: string) => { if (id === 'p-acme') throw new Error('Neon 500'); return 'updated' as const; } });
    const r = await runRetentionBackfill(tenants, 604_800, { check: false }, d);
    expect(r.failed).toEqual([{ slug: 'acme', error: 'Neon 500' }]);
    expect(r.updated).toEqual(['beta']);
  });

  it('a 404 is skipped for a deleting tenant (also under --check), but a failure for any other', async () => {
    const list = [
      { slug: 'del', status: 'deleting', neonProjectId: 'p-del' },
      { slug: 'live', status: 'active', neonProjectId: 'p-live' },
    ];
    const check = await runRetentionBackfill(list, 604_800, { check: true }, deps({ get: async () => 'not-found' as const }));
    expect(check.skippedDeleted).toEqual(['del']);
    expect(check.failed.map((f) => f.slug)).toEqual(['live']);
    const apply = await runRetentionBackfill(list, 604_800, { check: false }, deps({ set: async () => 'not-found' as const }));
    expect(apply.skippedDeleted).toEqual(['del']);
    expect(apply.failed.map((f) => f.slug)).toEqual(['live']);
  });
});

describe('migrate-all', () => {
  const mdeps = (o: Partial<TenantMigrationDeps> = {}): TenantMigrationDeps => ({
    pendingCount: vi.fn(async () => 1),
    migrate: vi.fn(async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND ep-x.neon.tech'), { code: 'ENOTFOUND' }); }),
    confirmedAbsent: vi.fn(async (): Promise<AbsenceCheck> => ({ absent: true })),
    redact: (m: string) => m,
    ...o,
  });

  it('includes deleting tenants', () => {
    expect(MIGRATABLE_TENANT_STATUSES).toContain('deleting');
    expect(MIGRATABLE_TENANT_STATUSES).not.toContain('deleted');
  });

  it('a deleting tenant whose database is confirmed deleted → skipped', async () => {
    const r = await migrateOneTenant({ slug: 'del', status: 'deleting', neonProjectId: 'p' }, 'postgres://x', false, mdeps());
    expect(r).toEqual({ outcome: 'skipped', detail: 'database deleted' });
  });

  it('a deleting tenant with a transient connect error (absence not confirmed) → FAILED', async () => {
    const r = await migrateOneTenant({ slug: 'del', status: 'deleting', neonProjectId: 'p' }, 'postgres://x', false,
      mdeps({ confirmedAbsent: vi.fn(async (): Promise<AbsenceCheck> => ({ absent: false })) }));
    expect(r).toEqual({ outcome: 'FAILED', detail: 'getaddrinfo ENOTFOUND ep-x.neon.tech' });
  });

  it('audit A11: a deleting Neon tenant with no NEON_API_KEY → FAILED with "NEON_API_KEY missing — cannot confirm deletion"', async () => {
    const t = { slug: 'del', status: 'deleting', neonProjectId: 'p-1' };
    const neonExists = vi.fn(async () => false);
    const check = await isTenantDatabaseConfirmedAbsent(t, 'u', {
      classify: () => ({ kind: 'neon-project' as const, projectId: 'p-1' }), neonProjectExists: neonExists, databaseExists: async () => true, hasNeonKey: false,
    });
    expect(check).toEqual({ absent: false, note: NEON_KEY_MISSING_NOTE });
    expect(neonExists).not.toHaveBeenCalled();
    const r = await migrateOneTenant(t, 'postgres://x', false, mdeps({ confirmedAbsent: async () => check }));
    expect(r).toEqual({ outcome: 'FAILED', detail: 'NEON_API_KEY missing — cannot confirm deletion' });
  });

  it('audit A11: both deploy workflows give the migrate steps NEON_API_KEY', () => {
    for (const wf of ['deploy-prod.yml', 'deploy-staging.yml']) {
      const src = readFileSync(path.join(ROOT, `.github/workflows/${wf}`), 'utf8');
      for (const step of ['npm run db:migrate:all', 'npm run db:migrate:check']) {
        const block = src.slice(src.indexOf(step), src.indexOf('- name:', src.indexOf(step)));
        expect(block, `${wf}: ${step}`).toMatch(/NEON_API_KEY:\s*\$\{\{\s*secrets\.NEON_API_KEY\s*\}\}/);
      }
    }
  });

  it('a non-deleting tenant that fails is FAILED and never probed for absence', async () => {
    const d = mdeps();
    const r = await migrateOneTenant({ slug: 'acme', status: 'active', neonProjectId: 'p' }, 'postgres://x', false, d);
    expect(r.outcome).toBe('FAILED');
    expect(d.confirmedAbsent).not.toHaveBeenCalled();
  });

  describe('confirmed absence', () => {
    const neonClass = () => ({ kind: 'neon-project' as const, projectId: 'p-1' });
    const localClass = () => ({ kind: 'local' as const, adminUrl: 'postgres://localhost/bytime', dbName: 'cp_del' });
    const t = { slug: 'del', status: 'deleting', neonProjectId: 'p-1' };

    it('Neon 404 → absent', async () => {
      expect(await isTenantDatabaseConfirmedAbsent(t, 'u', { classify: neonClass, neonProjectExists: async () => false, databaseExists: async () => true, hasNeonKey: true })).toEqual({ absent: true });
    });
    it('no pg_database row → absent', async () => {
      expect(await isTenantDatabaseConfirmedAbsent(t, 'u', { classify: localClass, neonProjectExists: async () => true, databaseExists: async () => false, hasNeonKey: false })).toEqual({ absent: true });
    });
    it('the project still exists → not absent', async () => {
      expect(await isTenantDatabaseConfirmedAbsent(t, 'u', { classify: neonClass, neonProjectExists: async () => true, databaseExists: async () => false, hasNeonKey: true })).toEqual({ absent: false });
    });
    it('a Neon API error or an unclassifiable URL → not confirmed', async () => {
      expect(await isTenantDatabaseConfirmedAbsent(t, 'u', { classify: neonClass, neonProjectExists: async () => { throw new Error('503'); }, databaseExists: async () => false, hasNeonKey: true })).toEqual({ absent: false });
      expect(await isTenantDatabaseConfirmedAbsent(t, 'u', { classify: () => { throw new Error('cannot classify'); }, neonProjectExists: async () => false, databaseExists: async () => false, hasNeonKey: true })).toEqual({ absent: false });
    });
  });
});

describe('founder-script target banner', () => {
  const REMOTE = 'postgresql://founder:s3cr3t-pw@ep-cool-123.us-east-1.aws.neon.tech/control?sslmode=require';

  it('prints host/db without credentials', () => {
    const banner = targetBanner(REMOTE);
    expect(banner).toContain('Target control plane: ep-cool-123.us-east-1.aws.neon.tech/control');
    expect(banner).not.toContain('s3cr3t-pw');
    expect(banner).not.toContain('founder');
    expect(banner).not.toContain('sslmode');
  });

  it('boxes a warning for a non-loopback target; a local one is one plain line', () => {
    expect(targetBanner(REMOTE)).toMatch(/╔[\s\S]*NOT A LOCAL DATABASE[\s\S]*╝/);
    expect(targetBanner('postgresql://bytime:pw@localhost:5432/bytime')).toBe('Target control plane: localhost:5432/bytime');
  });

  it('loopback detection', () => {
    for (const u of ['postgres://localhost/x', 'postgres://127.0.0.1/x', 'postgres://[::1]:5432/x', 'postgres://db.localhost/x']) expect(isLoopbackUrl(u)).toBe(true);
    for (const u of ['postgres://ep-x.neon.tech/x', 'postgres://localhost.evil.com/x', 'not a url', undefined]) expect(isLoopbackUrl(u)).toBe(false);
    expect(describeDatabaseUrl('::garbage::')).toBe('(unparseable URL)');
  });

  it('every founder script prints it', () => {
    for (const s of ['tenant-admin', 'delete-tenant', 'tenant-export', 'backfill-trial-dates', 'backfill-neon-project-ids',
      'backfill-neon-retention', 'migrate-all', 'provision-tenant', 'seed-tenant', 'seed-demo']) {
      expect(readFileSync(path.join(ROOT, `scripts/${s}.ts`), 'utf8'), s).toMatch(/printTargetBanner\(\)/);
    }
  });
});

describe('provision:tenant without NEON_API_KEY', () => {
  const REMOTE = 'postgresql://u:p@ep-x.us-east-1.aws.neon.tech/control';
  const LOCAL = 'postgresql://bytime:pw@localhost:5432/bytime';

  it('refuses when the admin URL actually used is non-loopback', () => {
    expect(provisionWithoutNeonRefusal({}, REMOTE)).toMatch(/non-local server/);
  });

  it('checks DEV_TENANT_ADMIN_DATABASE_URL first — a remote admin URL is refused even with a local control plane', () => {
    const env = { CONTROL_PLANE_DATABASE_URL: LOCAL, DEV_TENANT_ADMIN_DATABASE_URL: REMOTE };
    expect(localDevAdminUrl(env)).toBe(REMOTE);
    expect(provisionWithoutNeonRefusal(env, localDevAdminUrl(env))).not.toBeNull();
    const env2 = { CONTROL_PLANE_DATABASE_URL: REMOTE, DEV_TENANT_ADMIN_DATABASE_URL: LOCAL };
    expect(provisionWithoutNeonRefusal(env2, localDevAdminUrl(env2))).toBeNull();
  });

  it('allows a loopback admin URL, and anything when a Neon key is set', () => {
    expect(provisionWithoutNeonRefusal({}, LOCAL)).toBeNull();
    expect(provisionWithoutNeonRefusal({ NEON_API_KEY: 'k' }, REMOTE)).toBeNull();
  });

  it('the refusal message never includes credentials', () => {
    expect(provisionWithoutNeonRefusal({}, 'postgresql://u:hunter2@ep-x.neon.tech/control')).not.toContain('hunter2');
  });
});

describe('provision:tenant Terms record (audit §5)', () => {
  const base = ['acme', 'Acme Corp', 'founder@acme.com', 'Pat Founder'];

  it('refuses without a Terms record or --no-terms-record', () => {
    const r = parseProvisionArgs(base);
    expect(r).toEqual({ error: expect.stringMatching(/^Refusing: a founder-provisioned workspace needs the Terms record/) });
  });

  it('accepts --terms-version + --terms-accepted-at (ISO with zone) from the signed agreement', () => {
    expect(parseProvisionArgs([...base, '--terms-version', '2026-10-21-draft-1', '--terms-accepted-at', '2026-10-20T15:30:00Z'])).toEqual({
      slug: 'acme', name: 'Acme Corp', adminEmail: 'founder@acme.com', adminName: 'Pat Founder',
      terms: { version: '2026-10-21-draft-1', acceptedAt: new Date('2026-10-20T15:30:00Z') },
    });
  });

  it('--no-terms-record is accepted (and audited by the script), but not together with a Terms record', () => {
    expect(parseProvisionArgs([...base, '--no-terms-record'])).toMatchObject({ terms: 'none' });
    expect(parseProvisionArgs([...base, '--no-terms-record', '--terms-version', 'v'])).toEqual({ error: expect.stringMatching(/not both/) });
  });

  it('rejects half a record, a zone-less or invalid date, a future date, and unknown options', () => {
    expect(parseProvisionArgs([...base, '--terms-version', 'v'])).toHaveProperty('error');
    expect(parseProvisionArgs([...base, '--terms-version', 'v', '--terms-accepted-at', '2026-10-20 15:30'])).toEqual({ error: expect.stringMatching(/ISO date-time with a time zone/) });
    expect(parseProvisionArgs([...base, '--terms-version', 'v', '--terms-accepted-at', '2026-02-30T10:00:00Z'])).toHaveProperty('error');
    expect(parseProvisionArgs([...base, '--terms-version', 'v', '--terms-accepted-at', '2999-01-01T00:00:00Z'])).toEqual({ error: expect.stringMatching(/future/) });
    expect(parseProvisionArgs([...base, '--terms', 'v'])).toEqual({ error: expect.stringMatching(/Unknown option --terms/) });
  });

  it('the script passes the Terms record to provisionTenant and audits it', () => {
    const src = readFileSync(path.join(ROOT, 'scripts/provision-tenant.ts'), 'utf8');
    expect(src).toMatch(/parseProvisionArgs\(process\.argv\.slice\(2\)\)/);
    expect(src).toMatch(/termsVersion: terms\.version, termsAcceptedAt: terms\.acceptedAt/);
    expect(src).toMatch(/recordProvisionTerms\(tenant\.id, terms,/);
  });

  it('audit R8: a failed audit write after provisioning says "created, but recording … failed" with the audit-note command', () => {
    const withTerms = provisionRecordFailedMessage('acme', { version: '2026-10-21-draft-1', acceptedAt: new Date('2026-10-20T15:30:00Z') }, new Error('connection reset'));
    expect(withTerms).toMatch(/^Workspace "acme" created, but recording the Terms\/audit note failed \(connection reset\)\. Record it with `tenant:admin audit-note`/);
    expect(withTerms).toContain('npm run tenant:admin -- audit-note acme --note "Terms 2026-10-21-draft-1 accepted 2026-10-20T15:30:00.000Z (from the customer\'s signed agreement; provision:tenant)" --yes');
    expect(provisionRecordFailedMessage('acme', 'none', new Error('x'))).toContain('audit-note acme --note "provisioned without a Terms record" --yes');
    expect(withTerms).not.toMatch(/Provisioning failed/);

    // The script: "Provisioning failed" only around provisionTenant; the registry lookup + audit write have their own catch.
    const src = readFileSync(path.join(ROOT, 'scripts/provision-tenant.ts'), 'utf8');
    const provisionTry = src.slice(src.indexOf('r = await provisionTenant('), src.indexOf('// Audit R8'));
    expect(provisionTry).toMatch(/catch \(err\) \{\s*console\.error\('Provisioning failed:', err\);\s*process\.exit\(1\);/);
    const recordTry = src.slice(src.indexOf('// Audit R8'), src.indexOf("console.log(`✓ Provisioned"));
    expect(recordTry).toMatch(/recordProvisionTerms\(tenant\.id, terms,[\s\S]*catch \(err\) \{\s*console\.error\(`✗ \$\{provisionRecordFailedMessage\(r\.slug, terms, err\)\}`\);\s*process\.exit\(1\);/);
    expect(recordTry).not.toContain('Provisioning failed');
  });
});

describe('Sentry environments', () => {
  it('server and edge read SENTRY_ENVIRONMENT; the browser reads NEXT_PUBLIC_* vars', () => {
    for (const f of ['sentry.server.config.ts', 'sentry.edge.config.ts']) {
      expect(readFileSync(path.join(ROOT, f), 'utf8')).toMatch(/environment:\s*process\.env\.SENTRY_ENVIRONMENT/);
    }
    const client = readFileSync(path.join(ROOT, 'src/instrumentation-client.ts'), 'utf8');
    expect(client).toMatch(/environment:\s*process\.env\.NEXT_PUBLIC_SENTRY_ENVIRONMENT/);
    expect(client).toMatch(/process\.env\.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE/);
    expect(client).not.toMatch(/process\.env\.SENTRY_TRACES_SAMPLE_RATE/);
  });
});
