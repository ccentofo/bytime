/**
 * The `audit` command (feature-plan-database-backups.md §6.6), daily 11:17 UTC.
 *
 * Records the oldest backup's age, the bucket's versioning and stale uploads, the KMS key's state, whether the alert email
 * is confirmed, and drift of every protection (bucket policy, lifecycle, key policy, both alert rules and their targets,
 * the trail, the subscription's filter policy, the DLQ alarm, the topic policy, every backup role's trust and policies).
 * Drops abandoned rt_ databases only while holding RESTORE_TEST_LOCK_KEY (no test running). Runs the audit role's
 * permission probes. Every check is isolated: one that fails records `error` (or null) and its summary in `errors`, and the
 * row is still inserted. A 30-minute deadline inserts the row with what it has and exits 1.
 */
import postgres from 'postgres';
import { AUDIT_LOCK_KEY, RESTORE_TEST_LOCK_KEY } from '../../src/lib/tenant/backup-locks';
import type { BackupReader, BackupStore } from './lib/store';
import type { AuditClients } from './lib/aws-clients';
import type { KeyProbeClient, StoredEdk } from './lib/probes';
import { auditProbes, probesOk } from './lib/probes';
import { acquireLock, type Connect, type HeldLock, type LockTiming } from './lib/locks';
import { assertBackupTables, controlPlaneClient, insertPermissionCheck } from './lib/sql';
import { summaryOf } from './lib/summarize-error';
import { restoreServerRefusal, restoreUrlRefusal } from './lib/rt-guards';
import { sweepRtDatabases } from './lib/rt-db';
import { clientUrl } from './lib/pg-url';
import {
  accountIdFromKeyArn, ALL_ROLES, expectedDocuments, lifecycleDrift, NAMES, normalize, statementDrift, statementsOf,
} from './lib/expected-policies';
import { DAY, MINUTE } from './lib/util';

export interface AuditDeps {
  controlPlaneUrl: string;
  restoreTestUrl: string;
  reader: BackupReader;
  store: BackupStore;
  clients: AuditClients;
  keyClient: KeyProbeClient;
  keyArn: string;
  /** feature-plan-cloud-export.md §6.2: EXPORT_KEY_ARN (the exports bucket's key). */
  exportKeyArn: string;
  runId: string;
  log: (line: string) => void;
  now?: () => Date;
  deadlineMs?: number;
  lockTiming?: LockTiming;
  lockConnect?: Connect;
  /** Tests only, in-process (as in the restore test). */
  hostGuardOverride?: boolean;
}

export interface AuditRow {
  oldestObjectAt: Date | null;
  oldestKey: string | null;
  objectsOver29Days: number | null;
  totalObjects: number | null;
  totalBytes: number | null;
  versioningStatus: string | null;
  staleUploads: number | null;
  kmsKeyState: string | null;
  alertEmailConfirmed: boolean | null;
  protectionDrift: string | null;
  leftoverTestDbs: number | null;
  stuckTestDbs: number | null;
  errors: string | null;
}

/**
 * Every protection-drift finding against what AWS returned (exported for S20). feature-plan-cloud-export.md §6.2 (3d): both
 * buckets (each against its own policy and lifecycle rules; encryption for the exports bucket only: the backup bucket's data
 * is client-side encrypted) and both keys, including their state (`Enabled`; anything else, e.g. PendingDeletion, is drift).
 */
export async function protectionDrift(clients: AuditClients, keyArn: string, exportKeyArn: string): Promise<{ drift: string[]; errors: string[] }> {
  const exp = expectedDocuments({ accountId: accountIdFromKeyArn(keyArn), keyArn, exportKeyArn });
  const drift: string[] = [];
  const errors: string[] = [];
  const check = async (label: string, fn: () => Promise<void>) => {
    try { await fn(); } catch (e) { errors.push(summaryOf(`drift:${label}`, e)); }
  };
  await check('bucket-policy', async () => {
    const st = statementsOf(await clients.bucket.policy());
    if (st === null) drift.push('bucket-policy:missing');
    else drift.push(...statementDrift('bucket-policy', exp.bucketPolicy, st));
  });
  await check('lifecycle', async () => {
    drift.push(...lifecycleDrift('lifecycle', exp.lifecycle.backup, await clients.bucket.lifecycle()));
  });
  await check('key-state', async () => {
    const state = await clients.key.state();
    if (state !== 'Enabled') drift.push(`key-state:${state}`);
  });
  await check('exports-bucket-policy', async () => {
    const st = statementsOf(await clients.exports.policy());
    if (st === null) drift.push('exports-bucket-policy:missing');
    else drift.push(...statementDrift('exports-bucket-policy', exp.exportBucketPolicy, st));
  });
  await check('exports-lifecycle', async () => {
    drift.push(...lifecycleDrift('exports-lifecycle', exp.lifecycle.exports, await clients.exports.lifecycle()));
  });
  await check('exports-encryption', async () => {
    const enc = await clients.exports.encryption();
    if (!enc) { drift.push('exports-encryption:missing'); return; }
    if (enc.rules !== 1 || enc.algorithm !== 'aws:kms' || enc.keyId !== exportKeyArn || !enc.bucketKeyEnabled) drift.push('exports-encryption');
  });
  await check('export-key-policy', async () => {
    const st = statementsOf(await clients.exportKey.policy());
    if (st === null) drift.push('export-key-policy:missing');
    else drift.push(...statementDrift('export-key-policy', exp.exportKeyPolicy, st));
  });
  await check('export-key-state', async () => {
    const state = await clients.exportKey.state();
    if (state !== 'Enabled') drift.push(`export-key-state:${state}`);
  });
  await check('key-policy', async () => {
    const st = statementsOf(await clients.key.policy());
    if (st === null) drift.push('key-policy:missing');
    else drift.push(...statementDrift('key-policy', exp.keyPolicy, st));
  });
  for (const [name, pattern] of Object.entries(exp.rulePatterns)) {
    await check(`rule:${name}`, async () => {
      const r = await clients.rules.describe(name);
      if (!r) { drift.push(`rule:${name}:missing`); return; }
      if (r.state !== 'ENABLED') drift.push(`rule:${name}:state`);
      let actual: unknown = null;
      try { actual = r.eventPattern ? JSON.parse(r.eventPattern) : null; } catch { actual = null; }
      if (JSON.stringify(normalize(actual)) !== JSON.stringify(normalize(pattern))) drift.push(`rule:${name}:pattern`);
      const targets = await clients.rules.targets(name);
      if (!(targets.length === 1 && targets[0] === exp.topicArn)) drift.push(`rule:${name}:targets`);
    });
  }
  await check('trail', async () => { if (!(await clients.trail.isLogging())) drift.push('trail:not-logging'); });
  await check('subscription', async () => {
    for (const s of (await clients.topic.subscriptions()).filter((x) => x.protocol === 'email' && x.arn.startsWith('arn:'))) {
      if (await clients.topic.filterPolicy(s.arn)) drift.push('subscription:filter-policy');
    }
  });
  await check('alarm', async () => {
    const a = await clients.alarm.describe(NAMES.dlqAlarm);
    if (!a) { drift.push('alarm:missing'); return; }
    if (!a.actionsEnabled) drift.push('alarm:actions-disabled');
    if (!(a.alarmActions.length === 1 && a.alarmActions[0] === exp.topicArn)) drift.push('alarm:actions');
    if (a.metricName !== 'ApproximateNumberOfMessagesVisible' || a.namespace !== 'AWS/SQS' || a.threshold !== 0
      || a.comparison !== 'GreaterThanThreshold' || a.treatMissingData !== 'notBreaching' || a.dimensions.QueueName !== NAMES.dlq) drift.push('alarm:definition');
  });
  await check('topic-policy', async () => {
    const st = statementsOf(await clients.topic.policy());
    if (st === null) drift.push('topic-policy:missing');
    else drift.push(...statementDrift('topic-policy', exp.topicPolicy, st));
  });
  for (const role of ALL_ROLES) {
    await check(`role:${role}`, async () => {
      const e = exp.roles[role];
      const trust = await clients.iam.trust(role);
      if (trust === null) { drift.push(`role:${role}:missing`); return; }
      drift.push(...statementDrift(`role:${role}:trust`, e.trust, statementsOf(trust)));
      const names = await clients.iam.inlinePolicyNames(role);
      for (const n of names.filter((x) => x !== NAMES.inlinePolicy)) drift.push(`role:${role}:extra-policy:${n}`);
      if (!names.includes(NAMES.inlinePolicy)) drift.push(`role:${role}:policy:missing`);
      else drift.push(...statementDrift(`role:${role}:policy`, e.policy, statementsOf(await clients.iam.inlinePolicy(role, NAMES.inlinePolicy))));
      if ((await clients.iam.attachedPolicies(role)).length > 0) drift.push(`role:${role}:attached`);
    });
  }
  return { drift, errors };
}

export async function runAudit(deps: AuditDeps): Promise<{ exitCode: number; row: AuditRow | null }> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log;
  const deadlineMs = deps.deadlineMs ?? 30 * MINUTE;
  const cp = postgres(clientUrl(deps.controlPlaneUrl), { max: 2, connect_timeout: 30, onnotice: () => {}, connection: { statement_timeout: 60_000 } });
  let lock: HeldLock | null = null;
  try {
    await assertBackupTables(cp);
    lock = await acquireLock(deps.controlPlaneUrl, AUDIT_LOCK_KEY, { timing: deps.lockTiming, connect: deps.lockConnect });
    if (!lock) {
      log('another audit is running; exiting');
      return { exitCode: 0, row: null };
    }
    const row: AuditRow = {
      oldestObjectAt: null, oldestKey: null, objectsOver29Days: null, totalObjects: null, totalBytes: null, versioningStatus: null,
      staleUploads: null, kmsKeyState: null, alertEmailConfirmed: null, protectionDrift: null, leftoverTestDbs: null, stuckTestDbs: null, errors: null,
    };
    const errors: string[] = [];
    let inserted = false;
    const insert = async (extraError?: string) => {
      if (inserted) return;
      inserted = true;
      if (extraError) errors.push(extraError);
      row.errors = errors.length ? errors.join('; ').slice(0, 4000) : null;
      await cp`INSERT INTO backup_audits (run_id, run_at, oldest_object_at, oldest_key, objects_over_29_days, total_objects, total_bytes,
        versioning_status, stale_uploads, kms_key_state, alert_email_confirmed, protection_drift, leftover_test_dbs, stuck_test_dbs, errors)
        VALUES (${deps.runId}, ${now()}, ${row.oldestObjectAt}, ${row.oldestKey}, ${row.objectsOver29Days}, ${row.totalObjects}, ${row.totalBytes},
        ${row.versioningStatus}, ${row.staleUploads}, ${row.kmsKeyState}, ${row.alertEmailConfirmed}, ${row.protectionDrift},
        ${row.leftoverTestDbs}, ${row.stuckTestDbs}, ${row.errors})`;
    };
    const isolated = async (label: string, fn: () => Promise<void>) => {
      try { await fn(); } catch (e) { errors.push(summaryOf(label, e)); }
    };

    let newestKey: string | null = null;
    const checks = async () => {
      // 2. List v1/.
      await isolated('list', async () => {
        const objects = await deps.reader.list('v1/');
        const t = now().getTime();
        let oldest: (typeof objects)[number] | null = null;
        let newest: (typeof objects)[number] | null = null;
        let over = 0;
        let bytes = 0;
        for (const o of objects) {
          if (o.key.startsWith('v1/probe/')) continue;
          bytes += o.size;
          if (t - o.lastModified.getTime() > 29 * DAY) over++;
          if (!oldest || o.lastModified < oldest.lastModified) oldest = o;
          if (!newest || o.lastModified > newest.lastModified) newest = o;
        }
        row.totalObjects = objects.length;
        row.totalBytes = bytes;
        row.objectsOver29Days = over;
        row.oldestObjectAt = oldest?.lastModified ?? null;
        row.oldestKey = oldest?.key ?? null;
        newestKey = newest?.key ?? null;
      });
      // 3. Versioning; stale uploads.
      await isolated('versioning', async () => { row.versioningStatus = await deps.clients.bucket.versioning(); });
      await isolated('uploads', async () => {
        const t = now().getTime();
        row.staleUploads = (await deps.clients.bucket.multipartUploads()).filter((u) => t - u.initiated.getTime() > 4 * DAY).length;
      });
      // 4. Key state.
      try { row.kmsKeyState = await deps.clients.key.state(); } catch (e) { row.kmsKeyState = 'error'; errors.push(summaryOf('key-state', e)); }
      // 5. Alert email.
      await isolated('alert-email', async () => {
        const subs = await deps.clients.topic.subscriptions();
        row.alertEmailConfirmed = subs.some((s) => s.protocol === 'email' && s.arn.startsWith('arn:'));
      });
      // 5b. Protection drift.
      await isolated('drift', async () => {
        const d = await protectionDrift(deps.clients, deps.keyArn, deps.exportKeyArn);
        errors.push(...d.errors);
        row.protectionDrift = d.drift.length ? d.drift.join(', ').slice(0, 4000) : null;
      });
      // 6. Leftover test databases, only while no restore test runs.
      await isolated('sweep', async () => {
        const rtLock = await acquireLock(deps.controlPlaneUrl, RESTORE_TEST_LOCK_KEY, { timing: deps.lockTiming, connect: deps.lockConnect });
        if (!rtLock) return; // leftover_test_dbs stays null: skipped
        try {
          const refusal = restoreUrlRefusal(deps.controlPlaneUrl, deps.restoreTestUrl, { hostGuardOverride: deps.hostGuardOverride });
          if (refusal) throw new Error(`guard: ${refusal}`);
          const rt = postgres(clientUrl(deps.restoreTestUrl), { max: 1, connect_timeout: 30, onnotice: () => {}, connection: { statement_timeout: 60_000 } });
          try {
            const server = await restoreServerRefusal(rt);
            if (server) throw new Error(`guard: ${server}`);
            const r = await sweepRtDatabases(rt, now(), { log });
            row.leftoverTestDbs = r.dropped;
            row.stuckTestDbs = r.stuck;
          } finally {
            await rt.end({ timeout: 5 }).catch(() => {});
          }
        } finally {
          await rtLock.release();
        }
      });
      // 7. Permission probes.
      await isolated('probes', async () => {
        const [stored] = await cp<Array<{ detail: { edk?: string; edk_context?: Record<string, string> } }>>`SELECT detail FROM backup_permission_checks
          WHERE role = 'backup' AND detail ? 'edk' ORDER BY checked_at DESC LIMIT 1`;
        const storedEdk: StoredEdk | null = stored?.detail.edk ? { edk: stored.detail.edk, context: stored.detail.edk_context ?? {} } : null;
        const detail = await auditProbes(deps.store, deps.keyClient, { newestKey, storedEdk });
        await insertPermissionCheck(cp, { runId: deps.runId, role: 'audit', checkedAt: now(), ok: probesOk(detail), detail });
      });
    };

    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'deadline'>((resolve) => { timer = setTimeout(() => resolve('deadline'), deadlineMs); timer.unref?.(); });
    const outcome = await Promise.race([checks().then(() => 'done' as const), deadline]);
    clearTimeout(timer);
    if (outcome === 'deadline') {
      await insert('deadline');
      log('audit deadline reached; recorded what was collected');
      return { exitCode: 1, row };
    }
    await insert();
    log(`audit: ${row.totalObjects ?? '?'} objects, oldest ${row.oldestObjectAt?.toISOString() ?? 'none'}, key ${row.kmsKeyState}, drift ${row.protectionDrift ?? 'none'}${row.errors ? `, errors: ${row.errors}` : ''}`);
    return { exitCode: 0, row };
  } finally {
    await lock?.release();
    await cp.end({ timeout: 5 }).catch(() => {});
  }
}

export { controlPlaneClient };
