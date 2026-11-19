import { describe, it, expect } from 'vitest';

/**
 * feature-plan-cloud-export.md §11 T1 (`parseExportArgs`), the closing SNS lines' shapes (T30's unit half), the export
 * lock key, and the entry point's `export` environment checks (no AWS: `checksOnly` stops before any client is built).
 */
import { parseExportArgs, parseFailureLine, lines, exportRunId, newToken, deliveryKey, holdKey, EXPORT_DEFAULTS } from '../../../scripts/backup/export';
import { SWEEP_DEFAULTS, idOfKey } from '../../../scripts/backup/export-sweep';
import { main, OUTSIDE_ECS_REFUSAL } from '../../../scripts/backup/main';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { EXPORT_LOCK_KEY } from '@/lib/tenant/backup-locks';

const WS = '0b5b7b8e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const HOLD = '9f8e7d6c-5b4a-4321-8fed-cba987654321';
const NOW = new Date('2026-11-18T12:34:56Z');

const ok = (argv: string[]) => {
  const r = parseExportArgs(argv, NOW);
  if (!r.ok) throw new Error(`expected ok: ${r.message}`);
  return r.args;
};
const refused = (argv: string[]) => {
  const r = parseExportArgs(argv, NOW);
  if (r.ok) throw new Error('expected a refusal');
  return r;
};

describe('T1: parseExportArgs', () => {
  it('every mode with its required flags; --run-id optional (generated as task-<stamp>)', () => {
    expect(ok(['deliver', '--workspace', WS])).toEqual({ mode: 'deliver', workspaceId: WS, runId: 'task-20261118T123456Z' });
    expect(ok(['deliver', '--workspace', WS, '--extra', 'Legal@Example.com', '--reason', 'court order', '--run-id', 'gh-1-1']))
      .toEqual({ mode: 'deliver', workspaceId: WS, extra: 'Legal@Example.com', reason: 'court order', runId: 'gh-1-1' });
    expect(ok(['deliver', '--workspace', WS, '--reason', 'customer asked'])).toMatchObject({ reason: 'customer asked' });
    expect(ok(['hold', '--workspace', WS, '--reason', 'litigation'])).toEqual({ mode: 'hold', workspaceId: WS, reason: 'litigation', runId: 'task-20261118T123456Z' });
    expect(ok(['release', '--hold', HOLD, '--reason', 'case closed', '--run-id', 'cloudshell-x'])).toEqual({ mode: 'release', holdId: HOLD, reason: 'case closed', runId: 'cloudshell-x' });
    expect(ok(['sweep'])).toEqual({ mode: 'sweep', runId: 'task-20261118T123456Z' });
    expect(exportRunId(NOW)).toBe('task-20261118T123456Z');
  });

  it('an unknown flag exits 2 (an image older than the button), whatever the mode', () => {
    for (const argv of [['deliver', '--workspace', WS, '--force', 'x'], ['sweep', '--dry-run'], ['hold', '--targets', WS]]) {
      expect(refused(argv)).toMatchObject({ exitCode: 2, code: 'version-skew' });
    }
  });

  it('--extra on hold or release exits 1 with extra-not-allowed (not exit 2)', () => {
    expect(refused(['hold', '--workspace', WS, '--reason', 'r', '--extra', 'a@b.co'])).toMatchObject({ exitCode: 1, code: 'extra-not-allowed', mode: 'hold', target: WS });
    expect(refused(['release', '--hold', HOLD, '--reason', 'r', '--extra', 'a@b.co'])).toMatchObject({ exitCode: 1, code: 'extra-not-allowed', mode: 'release', target: HOLD });
  });

  it('bad uuids, emails and reasons are refused with exit 1', () => {
    const bad = [
      ['deliver'],
      ['deliver', '--workspace', WS.toUpperCase()],
      ['deliver', '--workspace', 'acme'],
      ['hold', '--workspace', WS], // no reason
      ['release', '--hold', 'not-a-uuid', '--reason', 'r'],
      ['release', '--workspace', WS, '--reason', 'r'],
      ['hold', '--hold', HOLD, '--reason', 'r'],
      ['deliver', '--workspace', WS, '--extra', 'two@a.co,three@b.co', '--reason', 'r'],
      ['deliver', '--workspace', WS, '--extra', 'no-at-sign', '--reason', 'r'],
      ['deliver', '--workspace', WS, '--extra', `${'a'.repeat(250)}@b.co`, '--reason', 'r'],
      ['deliver', '--workspace', WS, '--extra', 'a@b.co'], // an extra address needs a reason (§6.4)
      ['deliver', '--workspace', WS, '--reason', 'x'.repeat(201)],
      ['deliver', '--workspace', WS, '--reason', 'line\nbreak'],
      ['deliver', '--workspace', WS, '--reason', '   '],
      ['deliver', '--workspace', WS, '--run-id', 'has space'],
      ['deliver', '--workspace', WS, '--workspace', WS],
      ['deliver', 'hold', '--workspace', WS],
      ['wipe', '--workspace', WS],
      ['sweep', '--workspace', WS],
    ];
    for (const argv of bad) expect(refused(argv), argv.join(' ')).toMatchObject({ exitCode: 1 });
  });

  it('a value starting with - is refused (no flag confusion), and a flag without a value', () => {
    expect(refused(['deliver', '--workspace', '-x'])).toMatchObject({ exitCode: 1, code: 'bad-args' });
    expect(refused(['deliver', '--workspace', WS, '--reason', '--extra'])).toMatchObject({ exitCode: 1 });
    expect(refused(['deliver', '--workspace'])).toMatchObject({ exitCode: 1 });
  });
});

describe('T30 (unit half): the closing lines carry ids and codes only', () => {
  it('each outcome\'s shape; a release refusal targets the hold; a parse failure', () => {
    const exp = new Date('2026-11-25T12:00:00.000Z');
    expect(lines.delivered(WS, HOLD, 3, exp)).toBe(`export delivered: workspace ${WS}, delivery ${HOLD}, 3 recipient(s), expires 2026-11-25T12:00:00.000Z`);
    expect(lines.held(WS, HOLD)).toBe(`export held: workspace ${WS}, hold ${HOLD}`);
    expect(lines.released(HOLD)).toBe(`export released: hold ${HOLD}`);
    expect(lines.refused('deliver', `workspace ${WS}`, 'schema-skew')).toBe(`export refused: deliver, workspace ${WS}, schema-skew`);
    expect(lines.failed('hold', `workspace ${WS}`, 'too-large')).toBe(`export failed: hold, workspace ${WS}, too-large`);
    expect(lines.unknown('deliver', WS, 'delivery', HOLD)).toBe(`export outcome unknown: deliver, workspace ${WS}, delivery ${HOLD}`);
    expect(parseFailureLine(refused(['deliver', '--zap', 'x']))).toBe('export failed: parse, -, version-skew');
    expect(parseFailureLine(refused(['release', '--hold', HOLD, '--reason', 'r', '--extra', 'a@b.co']))).toBe(`export refused: release, hold ${HOLD}, extra-not-allowed`);
    expect(parseFailureLine(refused(['hold', '--workspace', WS]))).toBe(`export refused: hold, workspace ${WS}, bad-args`);
    expect(parseFailureLine(refused(['deliver', '--workspace', 'Acme-Slug']))).toBe('export refused: deliver, -, bad-args'); // never echoes a non-uuid
  });

  it('tokens are 32 random bytes in base64url (43 characters); keys put the id before the slug; limits', () => {
    const t = newToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newToken()).not.toBe(t);
    expect(deliveryKey(WS, 'acme', NOW)).toBe(`delivery/${WS}/acme-export-20261118.zip`);
    expect(holdKey(HOLD, 'acme', NOW)).toBe(`hold/${HOLD}/acme-export-20261118.zip`);
    expect(idOfKey(`hold/${HOLD}/acme-export-20261118.zip`)).toBe(HOLD);
    expect(EXPORT_DEFAULTS.deadlineMs).toBe(45 * 60_000);
    expect(EXPORT_DEFAULTS.hardExitAfterDeadlineMs).toBe(5 * 60_000);
    expect(EXPORT_DEFAULTS.linkValidityMs).toBe(7 * 24 * 3600_000);
    expect(SWEEP_DEFAULTS.deadlineMs).toBe(15 * 60_000);
    expect(SWEEP_DEFAULTS.orphanAgeMs).toBe(24 * 3600_000);
    expect(EXPORT_LOCK_KEY).toBe(728_402_206);
  });
});

describe('U5 (3d): the export command\'s environment checks in ECS', () => {
  const ECS = { ECS_CONTAINER_METADATA_URI_V4: 'http://169.254.170.2/v4/x' };
  const env = { ...ECS, CONTROL_PLANE_DATABASE_URL: 'postgresql://u:p@ep-x.us-east-1.aws.neon.tech/db', ENCRYPTION_KEY: 'a'.repeat(64), EXPORT_BUCKET: 'cadenzpoint-exports-111122223333', ALERT_TOPIC_ARN: 't', AWS_REGION: 'us-east-1' };
  const capture = () => { const l: string[] = []; return { l, log: (x: string) => l.push(x) }; };

  it('deliver/hold/release need the control plane, the key, the bucket, the topic, the region and the task metadata', async () => {
    expect(await main(['export', 'deliver', '--workspace', WS], env, { log: () => {}, checksOnly: true })).toBe(0);
    for (const k of ['CONTROL_PLANE_DATABASE_URL', 'ENCRYPTION_KEY', 'EXPORT_BUCKET', 'ALERT_TOPIC_ARN', 'AWS_REGION', 'ECS_CONTAINER_METADATA_URI_V4']) {
      const c = capture();
      expect(await main(['export', 'hold', '--workspace', WS, '--reason', 'r'], { ...env, [k]: '' }, { log: c.log, checksOnly: true }), k).toBe(1);
    }
  });

  it('sweep needs only the control plane, the bucket and the region (no key, topic or metadata)', async () => {
    const sweepEnv = { ...ECS, CONTROL_PLANE_DATABASE_URL: env.CONTROL_PLANE_DATABASE_URL, EXPORT_BUCKET: env.EXPORT_BUCKET, AWS_REGION: 'us-east-1' };
    expect(await main(['export', 'sweep'], sweepEnv, { log: () => {}, checksOnly: true })).toBe(0);
    expect(await main(['export', 'sweep'], { ...sweepEnv, EXPORT_BUCKET: '' }, { log: () => {}, checksOnly: true })).toBe(1);
  });

  it('FR7: an exit-2 parse failure publishes its line for deliver/hold/release, never for the sweep', async () => {
    const sent: string[] = [];
    const publisher = async (_s: string, m: string) => { sent.push(m); };
    const topicEnv = { ...ECS, ALERT_TOPIC_ARN: 't', AWS_REGION: 'us-east-1' };
    expect(await main(['export', 'sweep', '--newflag', 'x'], topicEnv, { log: () => {}, publisher })).toBe(2);
    expect(await main(['export', 'sweep', '--workspace', WS], topicEnv, { log: () => {}, publisher })).toBe(1);
    expect(sent).toEqual([]);
    expect(await main(['export', 'deliver', '--newflag', 'x'], topicEnv, { log: () => {}, publisher })).toBe(2);
    expect(await main(['export', 'release', '--hold', WS, '--reason', 'r', '--extra', 'a@b.co'], topicEnv, { log: () => {}, publisher })).toBe(1);
    expect(sent).toEqual(['export failed: parse, -, version-skew', `export refused: release, hold ${WS}, extra-not-allowed`]);
  });

  it('G1: outside ECS every export command is refused (the outside-ECS rule)', async () => {
    for (const argv of [['export', 'deliver', '--workspace', WS], ['export', 'hold', '--workspace', WS, '--reason', 'r'], ['export', 'release', '--hold', WS, '--reason', 'r'], ['export', 'sweep']]) {
      const c = capture();
      expect(await main(argv, { CONTROL_PLANE_DATABASE_URL: 'postgresql://u:p@localhost/x', EXPORT_BUCKET: 'b', AWS_REGION: 'us-east-1', ENCRYPTION_KEY: 'a'.repeat(64), ALERT_TOPIC_ARN: 't' }, { log: c.log, checksOnly: true }), argv.join(' ')).toBe(1);
      expect(c.l).toEqual([OUTSIDE_ECS_REFUSAL]);
    }
  });

  it('FR5: the export and sweep S3 clients have per-request timeouts', () => {
    const text = readFileSync(path.resolve(__dirname, '../../../scripts/backup/main.ts'), 'utf8');
    const exportBlock = text.slice(text.indexOf("if (command === 'export')"), text.indexOf("log('usage:"));
    const clients = exportBlock.match(/new S3Client\(\{[^)]*\}\)/g)!;
    expect(clients).toHaveLength(2);
    for (const c of clients) expect(c).toContain('requestHandler: { requestTimeout: 60_000, connectionTimeout: 10_000 }');
  });

  it('a parse failure exits with its code before any environment check; without a topic it only logs (D16)', async () => {
    const c = capture();
    expect(await main(['export', 'deliver', '--zap', 'x'], ECS, { log: c.log, checksOnly: true })).toBe(2);
    expect(c.l[0]).toMatch(/^refused: unknown flag --zap/);
    expect(c.l[1]).toMatch(/could not be emailed/);
    expect(await main(['export', 'hold', '--workspace', WS, '--extra', 'a@b.co', '--reason', 'r'], ECS, { log: () => {}, checksOnly: true })).toBe(1);
  });
});
