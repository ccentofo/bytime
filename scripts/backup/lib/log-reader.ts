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
  /** Every exact `BACKUP <cp> control-plane control-plane` line (feature-plan-control-plane-disaster.md §6.3 step 5). */
  controlPlaneLines(cp: string): Promise<BackupLine[]>;
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
    async controlPlaneLines(cp) {
      const out: BackupLine[] = [];
      let nextToken: string | undefined;
      for (let page = 0; page < 10_000; page++) {
        const r = await logs.send(new FilterLogEventsCommand({ logGroupName: o.logGroup, filterPattern: `"BACKUP ${cp} control-plane control-plane"`, nextToken }));
        for (const e of r.events ?? []) {
          const l = parseBackupLine(e.message ?? '');
          if (l && l.cp === cp && l.target === 'control-plane' && l.id === 'control-plane') out.push(l);
        }
        nextToken = r.nextToken;
        if (!nextToken) break;
      }
      return out;
    },
  };
}

// ---- the disaster log's rebuild lines (feature-plan-control-plane-disaster.md §6.4 R2) ------------------------------

/**
 * 3c's switch logs (disaster-steps.ts switchWorkspace, cleanupProject) and 3c-2's reconcile:
 *   SWITCHING <tenant> <old> <new> <key> <sha256>              just before COMMIT (may or may not have committed)
 *   LINKED <tenant> <old> <new> <key> <sha256>                 after COMMIT
 *   LINKED <tenant> <old|-> <new> <key|-> <sha|-> (healed by the re-read)   a commit whose acknowledgement was lost
 *   RELINKED <tenant> <start> <end>                            the reconcile re-applied a chain (§6.4 R2 step 10)
 * Project ids follow Neon's pattern `^[a-z0-9-]{1,60}$`; anything else is not one of these lines.
 */
export type RebuildLine =
  | { kind: 'SWITCHING' | 'LINKED'; tenantId: string; oldProjectId: string | null; newProjectId: string; healed: boolean; at: number }
  | { kind: 'RELINKED'; tenantId: string; oldProjectId: string; newProjectId: string; healed: false; at: number };

const SWITCH_RE = /^(SWITCHING|LINKED) ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) ([a-z0-9-]{1,60}) ([a-z0-9-]{1,60}) (\S+) (\S+)( \(healed by the re-read\))?$/;
const RELINKED_RE = /^RELINKED ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) ([a-z0-9-]{1,60}) ([a-z0-9-]{1,60})$/;

/** One exact rebuild line, or null. `at` is the log event's time (ms), which orders the lines. A `-` old id → null. */
export function parseRebuildLine(message: string, at: number): RebuildLine | null {
  const text = message.trim();
  const r = RELINKED_RE.exec(text);
  if (r) return { kind: 'RELINKED', tenantId: r[1], oldProjectId: r[2], newProjectId: r[3], healed: false, at };
  const m = SWITCH_RE.exec(text);
  if (!m) return null;
  const healed = m[7] !== undefined;
  if (healed && m[1] !== 'LINKED') return null; // only LINKED has a healed form
  if (m[4] === '-') return null;
  if (m[3] === '-' && !healed) return null; // only the healed form may lack the old id
  return { kind: m[1] as 'SWITCHING' | 'LINKED', tenantId: m[2], oldProjectId: m[3] === '-' ? null : m[3], newProjectId: m[4], healed, at };
}

export interface DisasterLogReader {
  /** Every exact rebuild line in the disaster log group at or after `since` (FilterLogEvents startTime). */
  rebuildLines(since: Date): Promise<RebuildLine[]>;
}

export function realDisasterLogReader(o: { region: string; logGroup: string; client?: Pick<CloudWatchLogsClient, 'send'> }): DisasterLogReader {
  const logs = o.client ?? new CloudWatchLogsClient({ region: o.region, requestHandler: { requestTimeout: 30_000, connectionTimeout: 10_000 } });
  return {
    async rebuildLines(since) {
      const out: RebuildLine[] = [];
      let nextToken: string | undefined;
      for (let page = 0; page < 10_000; page++) {
        // `?"LINKED" ?"SWITCHING"` matches either term anywhere (RELINKED contains LINKED); every line is re-parsed exactly.
        const r = await logs.send(new FilterLogEventsCommand({ logGroupName: o.logGroup, filterPattern: '?"LINKED" ?"SWITCHING"', startTime: since.getTime(), nextToken }));
        for (const e of r.events ?? []) {
          const l = parseRebuildLine(e.message ?? '', e.timestamp ?? 0);
          if (l) out.push(l);
        }
        nextToken = r.nextToken;
        if (!nextToken) break;
      }
      return out;
    },
  };
}
