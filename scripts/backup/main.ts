/**
 * The backup image's entry point (feature-plan-database-backups.md §6.2, §6.4 "Environment"). Bundled by
 * scripts/backup/bundle.mjs into /app/backup.cjs; `node /app/backup.cjs <command> [flags]`:
 *
 *   backup [--if-missing-today] [--only control-plane|<slug>] [--dry-run] [--concurrency N]
 *   audit
 *   restore-test [--if-missed]
 *   disaster workspace|rehearse|control-plane|reconcile --targets … [--override …] [--run-id …]
 *                       (feature-plan-disaster-restore.md §6.4, feature-plan-control-plane-disaster.md §6.1; an unknown
 *                       flag exits 2: the button reports "this image is older than the button")
 *   --self-check        loads every module and checks pg_dump / pg_restore are 16.x; needs no environment
 *
 * No dotenv is loaded here (scripts/backup/local.ts loads it for the local dry run). Outside ECS (no
 * ECS_CONTAINER_METADATA_URI_V4) only `--self-check` and `backup --dry-run` against a LOOPBACK control plane run, so a
 * production `.env` on a laptop can never start a dump (constraint 2). Logs carry no URLs, hosts or passwords; a crash
 * logs only the error summary.
 */
import { S3Client } from '@aws-sdk/client-s3';
import { runBackup } from './backup';
import { runAudit } from './audit';
import { runRestoreTest } from './restore-test';
import { parseDisasterArgs, runDisaster, DISASTER_DEFAULTS } from './disaster';
import { neonApi } from './lib/neon-api';
import { realLogReader } from './lib/log-reader';
import { kmsKeyringFactory } from './lib/crypto';
import { s3Reader, s3Store } from './lib/store';
import { realAuditClients, realKeyProbeClient, realDisasterEcs, realPublisher } from './lib/aws-clients';
import { checkToolVersion, defaultToolPath, FatalError, intEnv, isInEcs, listEnv, requireEnv, requireHexKey, runVersion, type Env, type VersionRunner } from './lib/env';
import { isLoopbackUrl } from './lib/loopback';
import { installCrashHandler, summaryOf } from './lib/summarize-error';
import { BACKUP_ID_RE, controlPlaneId, newRunId } from './lib/keys';
import { MINUTE, HOUR } from './lib/util';
import { tenantDbHistoryRetentionSeconds } from '../../src/lib/tenant/lifecycle-config';

export interface MainSeams {
  log?: (line: string) => void;
  runVersion?: VersionRunner;
  /** Tests: stop before any work once the run context and environment checks pass. */
  checksOnly?: boolean;
}

export const OUTSIDE_ECS_REFUSAL = 'refused: outside ECS only `--self-check` and `backup --dry-run` against a local control plane may run';

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

/**
 * The backup id (feature-plan-control-plane-disaster.md §6.0), resolved once here and passed in every task's deps. Inside
 * ECS a missing or invalid BACKUP_CONTROL_PLANE_ID is fatal (the stack injects it from SSM
 * `/cadenzpoint/backup/control-plane-backup-id`); outside ECS (the local dry run) it falls back to the host hash.
 */
export function resolveCpId(env: Env, controlPlaneUrl: string): string {
  if (isInEcs(env)) {
    const id = env.BACKUP_CONTROL_PLANE_ID;
    if (!id) throw new FatalError('BACKUP_CONTROL_PLANE_ID is required (SSM /cadenzpoint/backup/control-plane-backup-id)');
    if (!BACKUP_ID_RE.test(id)) throw new FatalError('BACKUP_CONTROL_PLANE_ID must be prod or staging');
    return id;
  }
  try {
    return controlPlaneId(controlPlaneUrl, env);
  } catch (e) {
    throw new FatalError((e as Error).message);
  }
}

function requireRegion(env: Env): string {
  const region = requireEnv(env, 'AWS_REGION');
  if (region !== 'us-east-1') throw new FatalError('AWS_REGION must be us-east-1');
  return region;
}

export async function selfCheck(env: Env, log: (l: string) => void, run: VersionRunner = runVersion): Promise<number> {
  // Every module is already loaded (they are imported above and bundled); now the tools.
  const dump = await checkToolVersion(defaultToolPath(env, 'pg_dump'), 'pg_dump', run);
  const restore = await checkToolVersion(defaultToolPath(env, 'pg_restore'), 'pg_restore', run);
  log(`self-check ok: ${dump}; ${restore}`);
  return 0;
}

export async function main(argv: string[], env: Env, seams: MainSeams = {}): Promise<number> {
  const log = seams.log ?? ((l: string) => console.log(l));
  try {
    if (argv.includes('--self-check')) return await selfCheck(env, log, seams.runVersion);
    const command = argv[0];
    const dryRun = command === 'backup' && argv.includes('--dry-run');
    if (!isInEcs(env)) {
      if (!(dryRun && isLoopbackUrl(env.CONTROL_PLANE_DATABASE_URL))) {
        log(OUTSIDE_ECS_REFUSAL);
        return 1;
      }
    }
    const stop = new AbortController();
    const onTerm = () => { log('stop requested (SIGTERM)'); stop.abort(); };
    process.once('SIGTERM', onTerm);
    const now = new Date();
    try {
      if (command === 'backup') {
        const controlPlaneUrl = requireEnv(env, 'CONTROL_PLANE_DATABASE_URL');
        requireHexKey(env);
        const cpId = resolveCpId(env, controlPlaneUrl);
        const only = flagValue(argv, '--only');
        const concurrencyFlag = flagValue(argv, '--concurrency');
        if (dryRun) {
          if (seams.checksOnly) return 0;
          return (await runBackup({
            controlPlaneUrl, cpId, store: undefined as never, keyring: undefined as never, pgDumpBin: '', pgDumpVersion: '', runId: newRunId(now), log,
            options: { dryRun: true, only },
          })).exitCode;
        }
        const bucket = requireEnv(env, 'BACKUP_BUCKET');
        const keyArn = requireEnv(env, 'BACKUP_KMS_KEY_ARN');
        const region = requireRegion(env);
        const pgDumpBin = requireEnv(env, 'BACKUP_PG_DUMP_BIN');
        const pgDumpVersion = await checkToolVersion(pgDumpBin, 'pg_dump', seams.runVersion);
        const concurrency = concurrencyFlag !== undefined ? intEnv({ c: concurrencyFlag }, 'c', 3) : intEnv(env, 'BACKUP_CONCURRENCY', 3);
        const targetDeadlineMs = intEnv(env, 'BACKUP_TARGET_DEADLINE_MINUTES', 30) * MINUTE;
        if (seams.checksOnly) return 0;
        const s3 = new S3Client({ region });
        return (await runBackup({
          controlPlaneUrl, cpId, store: s3Store(s3, bucket), keyring: kmsKeyringFactory(keyArn), keyClient: realKeyProbeClient(region, keyArn),
          pgDumpBin, pgDumpVersion, runId: newRunId(now), log, concurrency, targetDeadlineMs, stopSignal: stop.signal,
          options: { ifMissingToday: argv.includes('--if-missing-today'), only },
        })).exitCode;
      }
      if (command === 'restore-test') {
        const controlPlaneUrl = requireEnv(env, 'CONTROL_PLANE_DATABASE_URL');
        const restoreTestUrl = requireEnv(env, 'RESTORE_TEST_DATABASE_URL');
        const cpId = resolveCpId(env, controlPlaneUrl);
        const bucket = requireEnv(env, 'BACKUP_BUCKET');
        const keyArn = requireEnv(env, 'BACKUP_KMS_KEY_ARN');
        const region = requireRegion(env);
        const pgRestoreBin = requireEnv(env, 'BACKUP_PG_RESTORE_BIN');
        await checkToolVersion(pgRestoreBin, 'pg_restore', seams.runVersion);
        const decryptArns = listEnv(env, 'BACKUP_DECRYPT_KEY_ARNS');
        const keyring = kmsKeyringFactory(keyArn, decryptArns.length ? decryptArns : [keyArn]);
        const concurrency = intEnv(env, 'RESTORE_TEST_CONCURRENCY', 2);
        const runDeadlineMs = intEnv(env, 'RESTORE_TEST_DEADLINE_HOURS', 6) * HOUR;
        const targetDeadlineMs = intEnv(env, 'RESTORE_TEST_TARGET_DEADLINE_MINUTES', 120) * MINUTE;
        if (seams.checksOnly) return 0;
        const s3 = new S3Client({ region });
        return (await runRestoreTest({
          controlPlaneUrl, cpId, restoreTestUrl, reader: s3Reader(s3, bucket), store: s3Store(s3, bucket), keyring, pgRestoreBin, runId: newRunId(now), log,
          ifMissed: argv.includes('--if-missed'), concurrency, runDeadlineMs, targetDeadlineMs, stopSignal: stop.signal,
        })).exitCode;
      }
      if (command === 'audit') {
        const controlPlaneUrl = requireEnv(env, 'CONTROL_PLANE_DATABASE_URL');
        const restoreTestUrl = requireEnv(env, 'RESTORE_TEST_DATABASE_URL');
        const bucket = requireEnv(env, 'BACKUP_BUCKET');
        const keyArn = requireEnv(env, 'BACKUP_KMS_KEY_ARN');
        const topicArn = requireEnv(env, 'ALERT_TOPIC_ARN');
        requireEnv(env, 'ALERT_RULE_NAMES');
        const trailName = requireEnv(env, 'TRAIL_NAME');
        requireEnv(env, 'DLQ_ALARM_NAME');
        const region = requireRegion(env);
        kmsKeyringFactory(keyArn); // validates the key ARN shape
        if (seams.checksOnly) return 0;
        const s3 = new S3Client({ region, requestHandler: { requestTimeout: 30_000, connectionTimeout: 10_000 } });
        return (await runAudit({
          controlPlaneUrl, restoreTestUrl, reader: s3Reader(s3, bucket), store: s3Store(s3, bucket),
          clients: realAuditClients({ region, bucket, keyArn, topicArn, trailName }), keyClient: realKeyProbeClient(region, keyArn),
          keyArn, runId: newRunId(now), log,
        })).exitCode;
      }
      if (command === 'disaster') {
        // Parsed first: an unknown flag (a button newer than this image) exits 2 before any check.
        const parsed = parseDisasterArgs(argv.slice(1), now);
        if (!parsed.ok) {
          log(`refused: ${parsed.message}`);
          return parsed.exitCode;
        }
        const controlPlaneUrl = requireEnv(env, 'CONTROL_PLANE_DATABASE_URL');
        requireHexKey(env);
        const cpId = resolveCpId(env, controlPlaneUrl);
        // feature-plan-control-plane-disaster.md §6.2 item 2: the control-plane modes need the restore-test URL (network
        // first) and the disaster log group (the window's rebuild lines); 3c's workspace modes don't.
        const needsCpEnv = parsed.args.mode === 'control-plane' || parsed.args.mode === 'reconcile' || parsed.args.targets === 'control-plane';
        const restoreTestUrl = needsCpEnv ? requireEnv(env, 'RESTORE_TEST_DATABASE_URL') : undefined;
        const disasterLogGroup = needsCpEnv ? requireEnv(env, 'DISASTER_LOG_GROUP') : undefined;
        const apiKey = requireEnv(env, 'NEON_API_KEY');
        const orgId = requireEnv(env, 'NEON_ORG_ID');
        const restoreTestProjectId = requireEnv(env, 'RESTORE_TEST_PROJECT_ID');
        const controlPlaneProjectId = requireEnv(env, 'CONTROL_PLANE_PROJECT_ID');
        const bucket = requireEnv(env, 'BACKUP_BUCKET');
        const keyArn = requireEnv(env, 'BACKUP_KMS_KEY_ARN');
        const topicArn = requireEnv(env, 'ALERT_TOPIC_ARN');
        const logGroup = requireEnv(env, 'BACKUP_LOG_GROUP');
        const metadataUri = requireEnv(env, 'ECS_CONTAINER_METADATA_URI_V4');
        const regionId = requireEnv(env, 'NEON_REGION_ID');
        if (regionId !== 'aws-us-east-1') throw new FatalError('NEON_REGION_ID must be aws-us-east-1');
        const region = requireRegion(env);
        const pgRestoreBin = requireEnv(env, 'BACKUP_PG_RESTORE_BIN');
        await checkToolVersion(pgRestoreBin, 'pg_restore', seams.runVersion);
        try {
          tenantDbHistoryRetentionSeconds(); // a set-but-invalid NEON_HISTORY_RETENTION_SECONDS is fatal here, not mid-rebuild
        } catch (e) {
          throw new FatalError((e as Error).message);
        }
        const decryptArns = listEnv(env, 'BACKUP_DECRYPT_KEY_ARNS');
        const keyring = kmsKeyringFactory(keyArn, decryptArns.length ? decryptArns : [keyArn]);
        const deadlineMs = intEnv(env, 'DISASTER_DEADLINE_MINUTES', DISASTER_DEFAULTS.deadlineMs / MINUTE) * MINUTE;
        if (seams.checksOnly) return 0;
        const s3 = new S3Client({ region });
        return (await runDisaster(parsed.args, {
          controlPlaneUrl, cpId, restoreTestUrl, neon: neonApi({ apiKey, orgId }), ecs: realDisasterEcs({ region, metadataUri, family: 'cadenzpoint-backup-disaster' }),
          logReader: realLogReader({ region, logGroup }), disasterLogReader: disasterLogGroup ? realLogReader({ region, logGroup: disasterLogGroup }) : undefined, reader: s3Reader(s3, bucket), keyring, publish: realPublisher({ region, topicArn }),
          pgRestoreBin, regionId, restoreTestProjectId, controlPlaneProjectId, log, deadlineMs, stopSignal: stop.signal,
        })).exitCode;
      }
      log('usage: backup [--if-missing-today] [--only <slug>|control-plane] [--dry-run] [--concurrency N] | audit | restore-test [--if-missed] | disaster workspace|rehearse|control-plane|reconcile --targets … | --self-check');
      return 1;
    } finally {
      process.off('SIGTERM', onTerm);
    }
  } catch (e) {
    log(e instanceof FatalError ? `fatal: ${e.message}` : `fatal: ${summaryOf('start', e)}`);
    return 1;
  }
}

// Run when executed as the bundle (`node /app/backup.cjs …`), never when imported (tests, scripts/backup/local.ts).
if (/(^|[\\/])backup\.cjs$/.test(process.argv[1] ?? '')) {
  installCrashHandler((l) => console.error(l));
  void main(process.argv.slice(2), process.env).then((code) => process.exit(code));
}
