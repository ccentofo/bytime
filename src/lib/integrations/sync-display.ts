/**
 * Integration sends in words (feature-plan-ux-integrations-billing.md I5, I6, I7, §6). Pure: shared by the server
 * actions, the sync engine and the QuickBooks page.
 */
import type { CalendarDate } from '@/lib/calendar-date';
import type { Tone } from '@/lib/ui/status';

/** A `running` log older than this didn't finish (a function timeout leaves it running). */
export const STALE_RUNNING_MS = 15 * 60 * 1000;

export const SEND_RUNNING_MESSAGE = 'A send is already running. Try again in a few minutes.';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export interface SyncLogFacts {
  status: string;
  recordsPushed: number;
  recordsSkipped: number;
  errorSummary: string | null;
  startedAt: Date | null;
  createdAt: Date;
}

/** When the log's send started (startedAt, else createdAt for legacy rows). */
const startOf = (log: Pick<SyncLogFacts, 'startedAt' | 'createdAt'>) => new Date(log.startedAt ?? log.createdAt).getTime();

export function isStaleRunning(log: Pick<SyncLogFacts, 'status' | 'startedAt' | 'createdAt'>, now: number): boolean {
  return log.status === 'running' && now - startOf(log) >= STALE_RUNNING_MS;
}

/**
 * The §6 result: `head` is the badge word, `rest` follows it (head + rest is the full sentence), `tone` the badge tone.
 */
export function syncResultText(log: SyncLogFacts, now: number): { head: string; rest: string; tone: Tone } {
  const skipped = log.recordsSkipped > 0
    ? ` · ${plural(log.recordsSkipped, 'entry', 'entries')} skipped: people not matched`
    : '';
  switch (log.status) {
    case 'running':
      return isStaleRunning(log, now)
        ? { head: "Didn't finish", rest: '', tone: 'warn' }
        : { head: 'Sending…', rest: '', tone: 'info' };
    case 'success':
      if (log.recordsPushed === 0 && log.recordsSkipped === 0) {
        return { head: 'Nothing to send', rest: ': no approved hours in this period', tone: 'dim' };
      }
      if (log.recordsPushed === 0) return { head: 'Nothing sent', rest: skipped, tone: 'warn' };
      return { head: 'Sent', rest: skipped, tone: 'ok' };
    case 'partial':
      return { head: 'Partly sent', rest: skipped, tone: 'warn' };
    case 'failed':
      return { head: 'Failed', rest: log.errorSummary ? `: ${log.errorSummary}` : '', tone: 'bad' };
    default:
      return { head: 'Waiting', rest: '', tone: 'dim' };
  }
}

/** "See {n} failures": only when failed records exist (I7). */
export function seeFailuresLabel(failedRecords: number): string | null {
  return failedRecords > 0 ? `See ${plural(failedRecords, 'failure', 'failures')}` : null;
}

export interface CoverageLog {
  status: string;
  recordsPushed: number;
  periodStart: CalendarDate | null;
  periodEnd: CalendarDate | null;
  startedAt: Date | null;
  createdAt: Date;
}

/**
 * I6 duplicate guard. A period starting on `start` is covered by a log with records pushed, status success or partial,
 * and period_start <= start <= period_end — how the engine picks periods (sync-engine.ts getApprovedEntriesForSync), so
 * a legacy three-month window counts too. A stale `running` log covering it may have sent part of it. Returns the
 * newest such send of each kind.
 */
export function periodCoverage(logs: CoverageLog[], start: CalendarDate, now: number): { sentAt: Date | null; partlySentAt: Date | null } {
  const covers = (l: CoverageLog) => l.periodStart !== null && l.periodEnd !== null && l.periodStart <= start && start <= l.periodEnd;
  const newest = (ls: CoverageLog[]) => ls.reduce<Date | null>((acc, l) => {
    const at = new Date(l.startedAt ?? l.createdAt);
    return acc === null || at > acc ? at : acc;
  }, null);
  return {
    sentAt: newest(logs.filter((l) => covers(l) && l.recordsPushed > 0 && (l.status === 'success' || l.status === 'partial'))),
    partlySentAt: newest(logs.filter((l) => covers(l) && isStaleRunning(l, now))),
  };
}

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const RECORD_ID = new RegExp(`^(${UUID})-(${UUID})-(\\d{4}-\\d{2}-\\d{2})$`);

/**
 * A QuickBooks sync record's id, `${userId}-${clinOrIndirectId}-${date}` (quickbooks-online.ts), fixed width
 * 36 + 1 + 36 + 1 + 10. Anything else → null (shown raw).
 */
export function parseSyncRecordId(id: string): { userId: string; codeId: string; date: CalendarDate } | null {
  const m = RECORD_ID.exec(id);
  return m ? { userId: m[1].toLowerCase(), codeId: m[2].toLowerCase(), date: m[3] as CalendarDate } : null;
}

export type PersonMatchType = 'employee' | 'vendor';
export interface ProviderPerson { id: string; name: string; email?: string }
export interface EmailSuggestion { type: PersonMatchType; externalId: string; externalName: string }

const normalEmail = (e: string | undefined | null) => (e ?? '').trim().toLowerCase();

/**
 * I5: for each unmatched person, the one unmatched QuickBooks employee or vendor with the same email (case-insensitive).
 * An email on two unmatched records (two employees, or an employee and a vendor) is ambiguous and suggests nothing.
 */
export function emailSuggestions(
  people: Array<{ id: string; email: string }>,
  employees: ProviderPerson[],
  vendors: ProviderPerson[],
  mapped: { userIds: ReadonlySet<string>; employeeIds: ReadonlySet<string>; vendorIds: ReadonlySet<string> },
): Map<string, EmailSuggestion> {
  const byEmail = new Map<string, EmailSuggestion[]>();
  const add = (type: PersonMatchType, p: ProviderPerson) => {
    const key = normalEmail(p.email);
    if (!key) return;
    byEmail.set(key, [...(byEmail.get(key) ?? []), { type, externalId: p.id, externalName: p.name }]);
  };
  for (const e of employees) if (!mapped.employeeIds.has(e.id)) add('employee', e);
  for (const v of vendors) if (!mapped.vendorIds.has(v.id)) add('vendor', v);
  const out = new Map<string, EmailSuggestion>();
  for (const person of people) {
    if (mapped.userIds.has(person.id)) continue;
    const candidates = byEmail.get(normalEmail(person.email));
    if (candidates?.length === 1) out.set(person.id, candidates[0]);
  }
  return out;
}
