import 'server-only';
import { inArray } from 'drizzle-orm';
import type { ReadDb } from '@/db';
import { importBatches, periodEvents, users } from '@/db/schema';
import { calendarDayOf, formatCalendarDate, formatInstant, isCalendarDate } from '@/lib/calendar-date';

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
  /**
   * feature-plan-ux-approvals-payroll.md A1 / §3.1.4 — the in-app wording ("Returned", not "Rejected"; display only):
   * the line ("Approved by Ann on Oct 16, 2026", "Self-returned on …", "Returned in Paylocity by … on …"), or null.
   */
  uiText: string | null;
  /** "Self-approved" / "Self-returned", or null. */
  uiBadge: string | null;
  /** The decision's date as uiText shows it (imported: the imported decision date, never the import time), or null. */
  decidedAtText: string | null;
  /** Who decided: the decider; the employee for self kinds; the recorded reviewer for imported ones. */
  decidedByName: string | null;
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
  /** The event's comment (a return's reason) — read for the review's "last return" (UX-4b Part 2 §3.1.5). */
  comment?: string | null;
}

const meta = (m: unknown): Record<string, unknown> => (m && typeof m === 'object' ? m as Record<string, unknown> : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

export function approvalLabel(
  period: ApprovalLabelPeriod,
  events: ApprovalLabelEvent[],
  nameOf: (userId: string) => string | null,
  timeZone: string,
): ApprovalLabel {
  const none: ApprovalLabel = {
    kind: 'none', selfApproved: false, badge: null, text: null, approverName: null, uiText: null, uiBadge: null, decidedAtText: null, decidedByName: null,
  };
  if (period.status !== 'approved' && period.status !== 'rejected') return none;
  const verb = period.status === 'approved' ? 'Approved' : 'Rejected';
  const uiVerb = period.status === 'approved' ? 'Approved' : 'Returned';
  const decision = events
    .filter((e) => e.periodId === period.id && e.event === period.status)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];

  if (decision?.source === 'migration') {
    const m = meta(decision.originalMetadata);
    const reviewer = str(m.reviewer);
    const rawDate = str(m.reviewedAt);
    const decidedAtText = rawDate ? (isCalendarDate(rawDate) ? formatCalendarDate(rawDate, 'MMM D, YYYY') : rawDate) : null;
    return {
      kind: period.status === 'approved' ? 'imported-approved' : 'imported-rejected',
      selfApproved: false,
      badge: null,
      text: importedDecisionText(verb, decision),
      approverName: null,
      uiText: `${uiVerb} in ${decision.importSourceSystem ?? 'another system'} by ${reviewer ?? 'reviewer not recorded'} on ${decidedAtText ?? 'an unknown date'}`,
      uiBadge: null,
      decidedAtText,
      decidedByName: reviewer,
    };
  }

  const deciderId = decision?.actorId ?? period.reviewedBy;
  const at = decision?.createdAt ?? period.reviewedAt;
  // `text` keeps its zone label (unchanged for the PDF, reports, API); the UI fields show the workspace's calendar day.
  const when = at ? ` on ${formatInstant(at, timeZone, 'MMM D, YYYY')}` : '';
  const decidedAtText = at ? formatCalendarDate(calendarDayOf(at, timeZone), 'MMM D, YYYY') : null;
  const uiWhen = decidedAtText ? ` on ${decidedAtText}` : '';
  if (deciderId && deciderId === period.userId) {
    const badge = selfBadge(period.status);
    const uiBadge = period.status === 'approved' ? 'Self-approved' : 'Self-returned';
    return {
      kind: period.status === 'approved' ? 'self-approved' : 'self-rejected', selfApproved: period.status === 'approved', badge, text: `${badge}${when}`, approverName: null,
      uiText: `${uiBadge}${uiWhen}`, uiBadge, decidedAtText, decidedByName: nameOf(period.userId),
    };
  }
  const name = deciderId ? nameOf(deciderId) : null;
  return {
    kind: period.status === 'approved' ? 'approved' : 'rejected',
    selfApproved: false,
    badge: null,
    text: `${verb} by ${name ?? 'an unknown user'}${when}`,
    approverName: name,
    uiText: `${uiVerb} by ${name ?? 'an unknown user'}${uiWhen}`,
    uiBadge: null,
    decidedAtText,
    decidedByName: name,
  };
}

const selfBadge = (status: string) => (status === 'approved' ? 'Self-approved' : 'Self-rejected');
const importDay = (e: ApprovalLabelEvent) => (e.importedAt ?? e.createdAt).toISOString().slice(0, 10);

function importedDecisionText(verb: string, e: ApprovalLabelEvent): string {
  const m = meta(e.originalMetadata);
  return `${verb} in ${e.importSourceSystem ?? 'another system'} by ${str(m.reviewer) ?? 'reviewer not recorded'} on ${str(m.reviewedAt) ?? 'an unknown date'} (imported ${importDay(e)})`;
}

/**
 * One period event's line for the audit trail (C2 "audit trail period events"; C6), with the approval context a
 * self-approval recorded (CO-D19: active admins at that moment, the last switch-on). Same wording as approvalLabel.
 */
export function periodEventLabel(
  e: ApprovalLabelEvent & { approvalContext?: unknown },
  periodUserId: string,
  nameOf: (userId: string) => string | null,
  timeZone: string,
): { text: string; selfApproved: boolean; context: string | null } {
  const verb = e.event === 'approved' ? 'Approved' : e.event === 'rejected' ? 'Rejected' : 'Submitted';
  if (e.source === 'migration') {
    if (e.event === 'submitted') {
      const at = str(meta(e.originalMetadata).submittedAt) ?? 'an unknown date';
      return { text: `Submitted in ${e.importSourceSystem ?? 'another system'} on ${at} (imported ${importDay(e)})`, selfApproved: false, context: null };
    }
    return { text: importedDecisionText(verb, e), selfApproved: false, context: null };
  }
  const when = ` on ${formatInstant(e.createdAt, timeZone, 'MMM D, YYYY h:mm A')}`;
  const actor = e.actorId ? nameOf(e.actorId) : null;
  if (e.event === 'submitted') return { text: `Submitted by ${actor ?? 'an unknown user'}${when}`, selfApproved: false, context: null };
  if (e.actorId && e.actorId === periodUserId) {
    const c = meta(e.approvalContext);
    const count = typeof c.activeAdminCount === 'number' ? c.activeAdminCount : null;
    const enabledAt = str(c.selfApprovalEnabledAt);
    const enabledBy = str(c.selfApprovalEnabledBy);
    const parts = [
      count === null ? null : `${count} active admin${count === 1 ? '' : 's'} at the time`,
      enabledAt ? `self-approval on since ${formatInstant(new Date(enabledAt), timeZone, 'MMM D, YYYY')}${enabledBy ? ` (switched on by ${nameOf(enabledBy) ?? 'an unknown user'})` : ''}` : null,
    ].filter(Boolean);
    return { text: `${selfBadge(e.event)}${when}`, selfApproved: e.event === 'approved', context: parts.length ? parts.join('; ') : null };
  }
  return { text: `${verb} by ${actor ?? 'an unknown user'}${when}`, selfApproved: false, context: null };
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
      comment: periodEvents.comment,
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
      createdAt: r.createdAt, comment: r.comment,
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
