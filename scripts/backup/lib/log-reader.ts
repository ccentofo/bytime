/**
 * Reading 3b's `BACKUP` log lines (feature-plan-disaster-restore.md §6.4 step 4, §4.3.3). The backup task logs, after each
 * object and its sidecar are stored:
 *
 *   BACKUP <cp> <target> <id> <slug> <runId> <key> <sha256> <bytes>
 *
 * A catch-up or late object whose row failed is still restorable when its SHA-256 is confirmed by such a line. The filter
 * pattern is a quoted phrase (case-sensitive, matches anywhere), so every line is re-parsed exactly here. FilterLogEvents
 * pages may be empty and still carry a `nextToken`: paginate until there is none. The slug is parsed but never returned
 * (the disaster task's own log keeps ids only).
 */
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';

export interface BackupLine {
  cp: string;
  target: 'tenant' | 'control-plane';
  id: string;
  runId: string;
  key: string;
  sha256: string;
  bytes: number;
}

const LINE_RE = /^BACKUP ([0-9a-f]{12}|prod|staging) (tenant|control-plane) (\S+) \S+ (\S+) (v1\/\S+\.dump\.enc) ([0-9a-f]{64}) (\d+)$/;

/** One exact line, or null. Lines with a trailing ` row-failed` (the row insert failed) still confirm the object. */
export function parseBackupLine(message: string): BackupLine | null {
  const m = LINE_RE.exec(message.trim().replace(/ row-failed$/, ''));
  if (!m) return null;
  return { cp: m[1], target: m[2] as BackupLine['target'], id: m[3], runId: m[4], key: m[5], sha256: m[6], bytes: Number(m[7]) };
}

export interface LogReader {
  /** Every exact `BACKUP <cp> tenant <id>` line in the backup log group (newest retention: 30 days). */
  backupLines(cp: string, tenantId: string): Promise<BackupLine[]>;
}

export function realLogReader(o: { region: string; logGroup: string; client?: Pick<CloudWatchLogsClient, 'send'> }): LogReader {
  const logs = o.client ?? new CloudWatchLogsClient({ region: o.region, requestHandler: { requestTimeout: 30_000, connectionTimeout: 10_000 } });
  return {
    async backupLines(cp, tenantId) {
      const out: BackupLine[] = [];
      let nextToken: string | undefined;
      for (let page = 0; page < 10_000; page++) {
        const r = await logs.send(new FilterLogEventsCommand({ logGroupName: o.logGroup, filterPattern: `"BACKUP ${cp} tenant ${tenantId}"`, nextToken }));
        for (const e of r.events ?? []) {
          const l = parseBackupLine(e.message ?? '');
          if (l && l.cp === cp && l.target === 'tenant' && l.id === tenantId) out.push(l);
        }
        nextToken = r.nextToken;
        if (!nextToken) break;
      }
      return out;
    },
  };
}
