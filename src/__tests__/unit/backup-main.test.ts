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
  const backupEnv = { ...ECS, CONTROL_PLANE_DATABASE_URL: 'postgresql://u:p@ep-x.us-east-1.aws.neon.tech/db', ENCRYPTION_KEY: KEY, BACKUP_BUCKET: 'b', BACKUP_KMS_KEY_ARN: ARN, AWS_REGION: 'us-east-1', BACKUP_PG_DUMP_BIN: '/usr/lib/postgresql/16/bin/pg_dump' };
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
    const rt = { ...ECS, CONTROL_PLANE_DATABASE_URL: 'x', RESTORE_TEST_DATABASE_URL: 'y', BACKUP_BUCKET: 'b', BACKUP_KMS_KEY_ARN: ARN, AWS_REGION: 'us-east-1', BACKUP_PG_RESTORE_BIN: '/usr/lib/postgresql/16/bin/pg_restore' };
    expect(await main(['restore-test'], rt, { log: () => {}, runVersion: pg16, checksOnly: true })).toBe(0);
    expect(await main(['restore-test'], { ...rt, RESTORE_TEST_DATABASE_URL: '' }, { log: () => {}, runVersion: pg16, checksOnly: true })).toBe(1);
    const alias = capture();
    expect(await main(['restore-test'], { ...rt, BACKUP_KMS_KEY_ARN: 'arn:aws:kms:us-east-1:111122223333:alias/cadenzpoint-backup' }, { log: alias.log, runVersion: pg16, checksOnly: true })).toBe(1);
    expect(alias.lines[0]).toContain('key ARN');
    const au = { ...ECS, CONTROL_PLANE_DATABASE_URL: 'x', RESTORE_TEST_DATABASE_URL: 'y', BACKUP_BUCKET: 'b', BACKUP_KMS_KEY_ARN: ARN, ALERT_TOPIC_ARN: 't', ALERT_RULE_NAMES: 'a,b', TRAIL_NAME: 'tr', DLQ_ALARM_NAME: 'd', AWS_REGION: 'us-east-1' };
    expect(await main(['audit'], au, { log: () => {}, checksOnly: true })).toBe(0);
    for (const k of ['ALERT_TOPIC_ARN', 'ALERT_RULE_NAMES', 'TRAIL_NAME', 'DLQ_ALARM_NAME']) {
      expect(await main(['audit'], { ...au, [k]: '' }, { log: () => {}, checksOnly: true }), k).toBe(1);
    }
  });

  it('an unknown command prints the usage', async () => {
    const c = capture();
    expect(await main(['wipe'], ECS, { log: c.log })).toBe(1);
    expect(c.lines[0]).toMatch(/^usage: /);
  });
});
