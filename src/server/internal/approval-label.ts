import 'server-only';
import { inArray } from 'drizzle-orm';
import type { ReadDb } from '@/db';
import { importBatches, periodEvents, users } from '@/db/schema';
import { formatInstant } from '@/lib/calendar-date';

/**
 * The ONE place that formats a timesheet's approval line (feature-plan-certified-outputs.md C2 "Self-approved label
 * everywhere", C1 imported approvals). Used by the approvals list + review, the timesheet page status, the PDF, the
 * reports, the v1 API and the export; a static test forbids formatting the approver line anywhere else.
 */

export type ApprovalKind =
  | 'none' | 'approved' | 'rejected' | 'self-approved' | 'self-rejected' | 'imported-approved' | 'imported-rejected';

export interface ApprovalLabel {
  kind: ApprovalKind;
  /** True for a self-approval (CO-D6) — exposed as `selfApproved` by the v1 API and export. */
  selfApproved: boolean;
  /** "Self-approved" / "Self-rejected" badge text, or null. */
  badge: string | null;
  /** The full approval line, or null when the period isn't decided. */
  text: string | null;
  /** In-app decider's name (null for imported or undecided). */
  approverName: string | null;
}

export interface ApprovalLabelPeriod {
  id: string;
  userId: string;
  status: string;
  reviewedBy: string | null;
  reviewedAt: Date | null;
}

export interface ApprovalLabelEvent {
  periodId: string;
  event: string;
  actorId: string | null;
  source: string;
  originalMetadata: unknown;
  createdAt: Date;
  importSourceSystem: string | null;
  importedAt: Date | null;
}

const meta = (m: unknown): Record<string, unknown> => (m && typeof m === 'object' ? m as Record<string, unknown> : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

export function approvalLabel(
  period: ApprovalLabelPeriod,
  events: ApprovalLabelEvent[],
  nameOf: (userId: string) => string | null,
  timeZone: string,
): ApprovalLabel {
  const none: ApprovalLabel = { kind: 'none', selfApproved: false, badge: null, text: null, approverName: null };
  if (period.status !== 'approved' && period.status !== 'rejected') return none;
  const verb = period.status === 'approved' ? 'Approved' : 'Rejected';
  const decision = events
    .filter((e) => e.periodId === period.id && e.event === period.status)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];

  if (decision?.source === 'migration') {
    const m = meta(decision.originalMetadata);
    const reviewer = str(m.reviewer) ?? 'reviewer not recorded';
    const reviewedAt = str(m.reviewedAt) ?? 'an unknown date';
    const imported = decision.importedAt ? decision.importedAt.toISOString().slice(0, 10) : decision.createdAt.toISOString().slice(0, 10);
    return {
      kind: period.status === 'approved' ? 'imported-approved' : 'imported-rejected',
      selfApproved: false,
      badge: null,
      text: `${verb} in ${decision.importSourceSystem ?? 'another system'} by ${reviewer} on ${reviewedAt} (imported ${imported})`,
      approverName: null,
    };
  }

  const deciderId = decision?.actorId ?? period.reviewedBy;
  const at = decision?.createdAt ?? period.reviewedAt;
  const when = at ? ` on ${formatInstant(at, timeZone, 'MMM D, YYYY')}` : '';
  if (deciderId && deciderId === period.userId) {
    const badge = period.status === 'approved' ? 'Self-approved' : 'Self-rejected';
    return { kind: period.status === 'approved' ? 'self-approved' : 'self-rejected', selfApproved: period.status === 'approved', badge, text: `${badge}${when}`, approverName: null };
  }
  const name = deciderId ? nameOf(deciderId) : null;
  return {
    kind: period.status === 'approved' ? 'approved' : 'rejected',
    selfApproved: false,
    badge: null,
    text: `${verb} by ${name ?? 'an unknown user'}${when}`,
    approverName: name,
  };
}

/** Load what approvalLabel needs for a set of periods (events with their import batch, decider names). */
export async function loadApprovalLabelData(db: Pick<ReadDb, 'select'>, periods: ApprovalLabelPeriod[]): Promise<{
  events: ApprovalLabelEvent[];
  nameOf: (userId: string) => string | null;
}> {
  const ids = periods.map((p) => p.id);
  const rows = ids.length === 0 ? [] : await db
    .select({
      periodId: periodEvents.periodId, event: periodEvents.event, actorId: periodEvents.actorId, source: periodEvents.source,
      originalMetadata: periodEvents.originalMetadata, createdAt: periodEvents.createdAt, importBatchId: periodEvents.importBatchId,
    })
    .from(periodEvents).where(inArray(periodEvents.periodId, ids));
  const batchIds = [...new Set(rows.flatMap((r) => (r.importBatchId ? [r.importBatchId] : [])))];
  const batches = batchIds.length === 0 ? [] : await db
    .select({ id: importBatches.id, sourceSystem: importBatches.sourceSystem, importedAt: importBatches.importedAt })
    .from(importBatches).where(inArray(importBatches.id, batchIds));
  const batchById = new Map(batches.map((b) => [b.id, b]));
  const userIds = [...new Set([...rows.flatMap((r) => (r.actorId ? [r.actorId] : [])), ...periods.flatMap((p) => (p.reviewedBy ? [p.reviewedBy] : []))])];
  const names = userIds.length === 0 ? [] : await db.select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, userIds));
  const nameById = new Map(names.map((n) => [n.id, n.fullName]));
  return {
    events: rows.map((r) => ({
      periodId: r.periodId, event: r.event, actorId: r.actorId, source: r.source, originalMetadata: r.originalMetadata,
      createdAt: r.createdAt,
      importSourceSystem: r.importBatchId ? batchById.get(r.importBatchId)?.sourceSystem ?? null : null,
      importedAt: r.importBatchId ? batchById.get(r.importBatchId)?.importedAt ?? null : null,
    })),
    nameOf: (id) => nameById.get(id) ?? null,
  };
}

/** Labels for many periods at once. */
export async function approvalLabels(db: Pick<ReadDb, 'select'>, periods: ApprovalLabelPeriod[], timeZone: string): Promise<Map<string, ApprovalLabel>> {
  const { events, nameOf } = await loadApprovalLabelData(db, periods);
  return new Map(periods.map((p) => [p.id, approvalLabel(p, events, nameOf, timeZone)]));
}
