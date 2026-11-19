import { describe, it, expect, vi } from 'vitest';

/**
 * feature-plan-database-backups.md §11 U5 (the entry point's environment checks; outside ECS only --self-check and
 * `backup --dry-run` against a loopback control plane; --self-check's default tool paths) and S23 (a non-loopback
 * dry run is refused). No AWS: `checksOnly` stops before any client is built.
 */
import { main, OUTSIDE_ECS_REFUSAL } from '../../../scripts/backup/main';

const ECS = { ECS_CONTAINER_METADATA_URI_V4: 'http://169.254.170.2/v4/x' };
const KEY = 'a'.repeat(64);
const ARN = 'arn:aws:kms:us-east-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab';
const pg16 = async (bin: string) => `${bin.endsWith('pg_restore') ? 'pg_restore' : 'pg_dump'} (PostgreSQL) 16.14`;

function capture() {
  const lines: string[] = [];
  return { lines, log: (l: string) => lines.push(l) };
}

describe('U5: outside ECS', () => {
  it('refuses every command except --self-check and a loopback `backup --dry-run` (S23: a Neon URL is refused)', async () => {
    for (const argv of [['backup'], ['audit'], ['restore-test'], ['restore-test', '--if-missed'], ['backup', '--if-missing-today']]) {
      const c = capture();
      expect(await main(argv, { CONTROL_PLANE_DATABASE_URL: 'postgresql://u:p@localhost/x', ENCRYPTION_KEY: KEY }, { log: c.log, checksOnly: true }), argv.join(' ')).toBe(1);
      expect(c.lines).toEqual([OUTSIDE_ECS_REFUSAL]);
    }
    const neon = capture();
    expect(await main(['backup', '--dry-run'], { CONTROL_PLANE_DATABASE_URL: 'postgresql://u:p@ep-x-pooler.us-east-1.aws.neon.tech/db', ENCRYPTION_KEY: KEY }, { log: neon.log, checksOnly: true })).toBe(1);
    expect(neon.lines).toEqual([OUTSIDE_ECS_REFUSAL]);
    expect(neon.lines.join('')).not.toContain('neon.tech');
    const local = capture();
    expect(await main(['backup', '--dry-run'], { CONTROL_PLANE_DATABASE_URL: 'postgresql://u:p@localhost:5432/x', ENCRYPTION_KEY: KEY }, { log: local.log, checksOnly: true })).toBe(0);
  });

  it('--self-check uses the image paths when *_BIN are unset, and needs no other environment', async () => {
    const run = vi.fn(pg16);
    const c = capture();
    expect(await main(['--self-check'], {}, { log: c.log, runVersion: run })).toBe(0);
    expect(run.mock.calls.map((x) => x[0])).toEqual(['/usr/lib/postgresql/16/bin/pg_dump', '/usr/lib/postgresql/16/bin/pg_restore']);
    expect(c.lines[0]).toMatch(/^self-check ok: pg_dump \(PostgreSQL\) 16\.14; pg_restore \(PostgreSQL\) 16\.14$/);
    expect(await main(['--self-check'], {}, { log: c.log, runVersion: async () => 'pg_dump (PostgreSQL) 17.1' })).toBe(1);
  });
});

describe('U5: environment checks in ECS', () => {
  const backupEnv = { ...ECS, BACKUP_CONTROL_PLANE_ID: 'prod', CONTROL_PLANE_DATABASE_URL: 'postgresql://u:p@ep-x.us-east-1.aws.neon.tech/db', ENCRYPTION_KEY: KEY, BACKUP_BUCKET: 'b', BACKUP_KMS_KEY_ARN: ARN, AWS_REGION: 'us-east-1', BACKUP_PG_DUMP_BIN: '/usr/lib/postgresql/16/bin/pg_dump' };
  it('backup: every value present and valid → ok; each missing or empty one is fatal with its name; a non-hex key; a wrong region; pg_dump 17', async () => {
    expect(await main(['backup'], backupEnv, { log: () => {}, runVersion: pg16, checksOnly: true })).toBe(0);
    for (const k of ['CONTROL_PLANE_DATABASE_URL', 'ENCRYPTION_KEY', 'BACKUP_BUCKET', 'BACKUP_KMS_KEY_ARN', 'AWS_REGION', 'BACKUP_PG_DUMP_BIN']) {
      const c = capture();
      expect(await main(['backup'], { ...backupEnv, [k]: '' }, { log: c.log, runVersion: pg16, checksOnly: true }), k).toBe(1);
      expect(c.lines).toEqual([`fatal: ${k} is not set`]);
    }
    const hex = capture();
    expect(await main(['backup'], { ...backupEnv, ENCRYPTION_KEY: 'not-hex' }, { log: hex.log, runVersion: pg16, checksOnly: true })).toBe(1);
    expect(hex.lines).toEqual(['fatal: ENCRYPTION_KEY must be 64 hex characters']);
    const region = capture();
    expect(await main(['backup'], { ...backupEnv, AWS_REGION: 'us-east-2' }, { log: region.log, runVersion: pg16, checksOnly: true })).toBe(1);
    expect(region.lines).toEqual(['fatal: AWS_REGION must be us-east-1']);
    expect(await main(['backup'], backupEnv, { log: () => {}, runVersion: async () => 'pg_dump (PostgreSQL) 17.2', checksOnly: true })).toBe(1);
  });

  it('restore-test and audit: their required values; an alias for the key is refused', async () => {
    const rt = { ...ECS, BACKUP_CONTROL_PLANE_ID: 'prod', CONTROL_PLANE_DATABASE_URL: 'x', RESTORE_TEST_DATABASE_URL: 'y', BACKUP_BUCKET: 'b', BACKUP_KMS_KEY_ARN: ARN, AWS_REGION: 'us-east-1', BACKUP_PG_RESTORE_BIN: '/usr/lib/postgresql/16/bin/pg_restore' };
    expect(await main(['restore-test'], rt, { log: () => {}, runVersion: pg16, checksOnly: true })).toBe(0);
    expect(await main(['restore-test'], { ...rt, RESTORE_TEST_DATABASE_URL: '' }, { log: () => {}, runVersion: pg16, checksOnly: true })).toBe(1);
    const alias = capture();
    expect(await main(['restore-test'], { ...rt, BACKUP_KMS_KEY_ARN: 'arn:aws:kms:us-east-1:111122223333:alias/cadenzpoint-backup' }, { log: alias.log, runVersion: pg16, checksOnly: true })).toBe(1);
    expect(alias.lines[0]).toContain('key ARN');
    const au = { ...ECS, CONTROL_PLANE_DATABASE_URL: 'x', RESTORE_TEST_DATABASE_URL: 'y', BACKUP_BUCKET: 'b', BACKUP_KMS_KEY_ARN: ARN, ALERT_TOPIC_ARN: 't', ALERT_RULE_NAMES: 'a,b', TRAIL_NAME: 'tr', DLQ_ALARM_NAME: 'd', AWS_REGION: 'us-east-1', EXPORT_BUCKET: 'eb', EXPORT_KEY_ARN: ARN.replace('1234abcd', '5678efab') };
    expect(await main(['audit'], au, { log: () => {}, checksOnly: true })).toBe(0);
    for (const k of ['ALERT_TOPIC_ARN', 'ALERT_RULE_NAMES', 'TRAIL_NAME', 'DLQ_ALARM_NAME', 'EXPORT_BUCKET', 'EXPORT_KEY_ARN']) {
      expect(await main(['audit'], { ...au, [k]: '' }, { log: () => {}, checksOnly: true }), k).toBe(1);
    }
    // feature-plan-cloud-export.md §6.2: the export key's ARN, never its alias.
    const exportAlias = capture();
    expect(await main(['audit'], { ...au, EXPORT_KEY_ARN: 'arn:aws:kms:us-east-1:111122223333:alias/cadenzpoint-exports' }, { log: exportAlias.log, checksOnly: true })).toBe(1);
    expect(exportAlias.lines).toEqual(['fatal: EXPORT_KEY_ARN must be a key ARN']);
  });

  it('an unknown command prints the usage', async () => {
    const c = capture();
    expect(await main(['wipe'], ECS, { log: c.log })).toBe(1);
    expect(c.lines[0]).toMatch(/^usage: /);
  });
});

describe('3c: the disaster command (feature-plan-disaster-restore.md §6.3, §6.4 "argv")', () => {
  const A = '0a1b2c3d-1111-4222-8333-444455556666';
  const env = {
    ...ECS, BACKUP_CONTROL_PLANE_ID: 'prod', CONTROL_PLANE_DATABASE_URL: 'postgresql://u:p@ep-x-pooler.us-east-1.aws.neon.tech/cp', ENCRYPTION_KEY: KEY, NEON_API_KEY: 'k', NEON_ORG_ID: 'org-1',
    RESTORE_TEST_PROJECT_ID: 'prj-rt', CONTROL_PLANE_PROJECT_ID: 'prj-cp', BACKUP_BUCKET: 'b', BACKUP_KMS_KEY_ARN: ARN, BACKUP_DECRYPT_KEY_ARNS: ARN,
    ALERT_TOPIC_ARN: 't', BACKUP_LOG_GROUP: '/cadenzpoint/backup/backup', NEON_REGION_ID: 'aws-us-east-1', AWS_REGION: 'us-east-1',
    BACKUP_PG_RESTORE_BIN: '/usr/lib/postgresql/16/bin/pg_restore', DISASTER_DEADLINE_MINUTES: '330',
  };

  it('is refused outside ECS like every other command', async () => {
    const c = capture();
    expect(await main(['disaster', 'workspace', '--targets', A], { CONTROL_PLANE_DATABASE_URL: 'postgresql://u:p@localhost/x' }, { log: c.log, checksOnly: true })).toBe(1);
    expect(c.lines).toEqual([OUTSIDE_ECS_REFUSAL]);
  });

  it('an unknown flag exits 2 before any environment check (version skew: "image older than the button")', async () => {
    const c = capture();
    expect(await main(['disaster', 'workspace', '--targets', A, '--from-the-future', 'x'], ECS, { log: c.log, checksOnly: true })).toBe(2);
    expect(c.lines[0]).toMatch(/^refused: unknown flag/);
    expect(await main(['disaster', 'workspace', '--targets', 'acme'], env, { log: () => {}, checksOnly: true })).toBe(1);
  });

  it('its required values; a set-but-invalid NEON_HISTORY_RETENTION_SECONDS is fatal at the start; the region must be us-east-1', async () => {
    expect(await main(['disaster', 'rehearse', '--targets', 'auto'], env, { log: () => {}, runVersion: pg16, checksOnly: true })).toBe(0);
    for (const k of ['NEON_API_KEY', 'NEON_ORG_ID', 'RESTORE_TEST_PROJECT_ID', 'CONTROL_PLANE_PROJECT_ID', 'ALERT_TOPIC_ARN', 'BACKUP_LOG_GROUP', 'NEON_REGION_ID', 'ENCRYPTION_KEY', 'BACKUP_PG_RESTORE_BIN']) {
      expect(await main(['disaster', 'rehearse', '--targets', 'auto'], { ...env, [k]: '' }, { log: () => {}, runVersion: pg16, checksOnly: true }), k).toBe(1);
    }
    expect(await main(['disaster', 'rehearse', '--targets', 'auto'], { ...env, NEON_REGION_ID: 'aws-eu-central-1' }, { log: () => {}, runVersion: pg16, checksOnly: true })).toBe(1);
    vi.stubEnv('NEON_HISTORY_RETENTION_SECONDS', '7d');
    try {
      const c = capture();
      expect(await main(['disaster', 'rehearse', '--targets', 'auto'], env, { log: c.log, runVersion: pg16, checksOnly: true })).toBe(1);
      expect(c.lines[0]).toContain('NEON_HISTORY_RETENTION_SECONDS');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('main.ts never passes the test-only hostMap or connector (impact analysis §4, D10; fix round 2)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../../scripts/backup/main.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/hostMap/);
    expect(src).not.toMatch(/\bconnector\b/); // fix round 2: the test-only connection seam, likewise
    // Neither seam is ever read from the environment.
    for (const f of ['scripts/backup/disaster.ts', 'scripts/backup/disaster-workspace.ts', 'scripts/backup/disaster-steps.ts']) {
      expect(readFileSync(new URL(`../../../${f}`, import.meta.url), 'utf8'), f).not.toMatch(/env\.(HOST_MAP|CONNECTOR)|process\.env\.[A-Z_]*(HOST|CONNECT)/);
    }
  });
});

// ---- feature-plan-control-plane-disaster.md §11 T1 (main's half), T2 -------------------------------------------------
describe('T2: the backup id in ECS', () => {
  const base = { ...ECS, CONTROL_PLANE_DATABASE_URL: 'postgresql://u:p@ep-x-pooler.us-east-1.aws.neon.tech/cp', ENCRYPTION_KEY: KEY, BACKUP_BUCKET: 'b', BACKUP_KMS_KEY_ARN: ARN, AWS_REGION: 'us-east-1' };
  const cmds: Array<[string[], Record<string, string>]> = [
    [['backup'], { BACKUP_PG_DUMP_BIN: '/usr/lib/postgresql/16/bin/pg_dump' }],
    [['restore-test'], { RESTORE_TEST_DATABASE_URL: 'y', BACKUP_PG_RESTORE_BIN: '/usr/lib/postgresql/16/bin/pg_restore' }],
    [['disaster', 'rehearse', '--targets', 'auto'], {
      NEON_API_KEY: 'k', NEON_ORG_ID: 'org-1', RESTORE_TEST_PROJECT_ID: 'prj-rt', CONTROL_PLANE_PROJECT_ID: 'prj-cp', ALERT_TOPIC_ARN: 't',
      BACKUP_LOG_GROUP: '/cadenzpoint/backup/backup', NEON_REGION_ID: 'aws-us-east-1', BACKUP_PG_RESTORE_BIN: '/usr/lib/postgresql/16/bin/pg_restore',
    }],
  ];
  for (const [argv, extra] of cmds) {
    it(`${argv[0]}: missing → fatal; \`Prod\` or \`probe\` → fatal; \`prod\` and \`staging\` → ok`, async () => {
      const env = { ...base, ...extra };
      const missing = capture();
      expect(await main(argv, env, { log: missing.log, runVersion: pg16, checksOnly: true })).toBe(1);
      expect(missing.lines).toEqual(['fatal: BACKUP_CONTROL_PLANE_ID is required (SSM /cadenzpoint/backup/control-plane-backup-id)']);
      for (const bad of ['Prod', 'probe', '']) {
        const c = capture();
        expect(await main(argv, { ...env, BACKUP_CONTROL_PLANE_ID: bad }, { log: c.log, runVersion: pg16, checksOnly: true }), bad).toBe(1);
        expect(c.lines[0]).toMatch(/^fatal: BACKUP_CONTROL_PLANE_ID (is required|must be prod or staging)/);
      }
      for (const good of ['prod', 'staging']) expect(await main(argv, { ...env, BACKUP_CONTROL_PLANE_ID: good }, { log: () => {}, runVersion: pg16, checksOnly: true }), good).toBe(0);
    });
  }

  it('audit and --self-check never read it', async () => {
    const au = { ...ECS, CONTROL_PLANE_DATABASE_URL: 'x', RESTORE_TEST_DATABASE_URL: 'y', BACKUP_BUCKET: 'b', BACKUP_KMS_KEY_ARN: ARN, ALERT_TOPIC_ARN: 't', ALERT_RULE_NAMES: 'a,b', TRAIL_NAME: 'tr', DLQ_ALARM_NAME: 'd', AWS_REGION: 'us-east-1', EXPORT_BUCKET: 'eb', EXPORT_KEY_ARN: ARN.replace('1234abcd', '5678efab') };
    expect(await main(['audit'], au, { log: () => {}, checksOnly: true })).toBe(0);
    expect(await main(['audit'], { ...au, BACKUP_CONTROL_PLANE_ID: 'junk' }, { log: () => {}, checksOnly: true })).toBe(0);
    expect(await main(['--self-check'], { BACKUP_CONTROL_PLANE_ID: 'junk' }, { log: () => {}, runVersion: pg16 })).toBe(0);
  });

  it('the control-plane modes also need RESTORE_TEST_DATABASE_URL and DISASTER_LOG_GROUP; the workspace modes don\'t', async () => {
    const env = { ...base, ...cmds[2][1], BACKUP_CONTROL_PLANE_ID: 'prod', RESTORE_TEST_DATABASE_URL: 'y', DISASTER_LOG_GROUP: '/cadenzpoint/backup/disaster' };
    for (const argv of [['disaster', 'control-plane', '--targets', 'control-plane'], ['disaster', 'reconcile', '--targets', 'control-plane'], ['disaster', 'rehearse', '--targets', 'control-plane']]) {
      expect(await main(argv, env, { log: () => {}, runVersion: pg16, checksOnly: true }), argv[1]).toBe(0);
      for (const k of ['RESTORE_TEST_DATABASE_URL', 'DISASTER_LOG_GROUP']) {
        const c = capture();
        expect(await main(argv, { ...env, [k]: '' }, { log: c.log, runVersion: pg16, checksOnly: true }), `${argv[1]} ${k}`).toBe(1);
        expect(c.lines).toEqual([`fatal: ${k} is not set`]);
      }
    }
    const workspaceEnv: Record<string, string> = { ...env };
    delete workspaceEnv.RESTORE_TEST_DATABASE_URL;
    delete workspaceEnv.DISASTER_LOG_GROUP;
    expect(await main(['disaster', 'rehearse', '--targets', 'auto'], workspaceEnv, { log: () => {}, runVersion: pg16, checksOnly: true })).toBe(0);
  });
});

describe('T1: main resolves the id once and passes cpId to every task', () => {
  it('resolveCpId uses the env it is given (not the process environment); outside ECS it falls back to the host hash', async () => {
    const { resolveCpId } = await import('../../../scripts/backup/main');
    const { controlPlaneId } = await import('../../../scripts/backup/lib/keys');
    expect(process.env.BACKUP_CONTROL_PLANE_ID).toBeUndefined();
    expect(resolveCpId({ ...ECS, BACKUP_CONTROL_PLANE_ID: 'staging' }, 'postgresql://u:p@ep-x.us-east-1.aws.neon.tech/cp')).toBe('staging');
    expect(resolveCpId({ BACKUP_CONTROL_PLANE_ID: 'prod' }, 'postgresql://u:p@localhost/cp')).toBe('prod');
    expect(resolveCpId({}, 'postgresql://u:p@localhost/cp')).toBe(controlPlaneId('postgresql://u:p@localhost/cp', {}));
    expect(() => resolveCpId({ BACKUP_CONTROL_PLANE_ID: 'Prod' }, 'postgresql://u:p@localhost/cp')).toThrow(/prod or staging/);
  });

  it('runBackup (both calls), runRestoreTest and runDisaster each receive cpId; the three callers never compute it', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../../scripts/backup/main.ts', import.meta.url), 'utf8');
    for (const call of src.split(/await (?=run(?:Backup|RestoreTest|Disaster)\()/).slice(1)) expect(call.slice(0, 400)).toMatch(/\bcpId\b/);
    expect(src.match(/await run(Backup|RestoreTest|Disaster)\(/g)).toHaveLength(4);
    for (const f of ['scripts/backup/backup.ts', 'scripts/backup/restore-test.ts', 'scripts/backup/disaster-workspace.ts', 'scripts/backup/disaster.ts']) {
      expect(readFileSync(new URL(`../../../${f}`, import.meta.url), 'utf8'), f).not.toMatch(/controlPlaneId\(/);
    }
  });
});
