'use server';

import { getDb, getDbForWrite } from '@/db';
import { isUniqueViolation } from '@/lib/db-errors';
import { timesheetPeriods, users, timesheetEntries, periodEvents } from '@/db/schema';
import { eq, and, inArray, gte, lt, sql } from 'drizzle-orm';
import { requireSession, requireApprover, requireApproverFresh, getEmployeeScope, AuthorizationError } from '@/lib/session';
import { getPeriodStatusFor, lockEmployeeTimesheet, resolvePeriod, type PeriodInfo, type PeriodStatus } from '@/server/internal/periods';
import { closeImportWindowOnSubmit, lockImportWindowShared } from '@/server/internal/import-window';
import { getSupervisorScopeInfo } from '@/server/internal/supervisor-scope';
import { canApprove, loadApprovalFacts, lockUserRulesShared, selfApprovalAvailable, selfApprovalContext } from '@/server/internal/approval-rules';
import { approvalLabels } from '@/server/internal/approval-label';
import { notifySubmissionRecipients } from '@/server/internal/submission-notify';
import { getWorkspaceToday } from '@/server/internal/workspace-settings';
import { existingPeriodLength, loadScheduleResolver } from '@/server/internal/pay-period-config';
import { sendTimesheetApprovedEmail, sendTimesheetRejectedEmail } from '@/lib/email/send';
import { scheduleEmail } from '@/lib/email/schedule';
import { getTenantSlug } from '@/lib/tenant/context';
import { tenantBaseUrl } from '@/lib/tenant/host';
import { isNotificationEnabled } from '@/server/internal/notifications';
import { getLastWeekdayInPeriod } from '@/lib/date-utils';
import { addDays, formatInstant, isBefore, formatCalendarDate, parseCalendarDate, type CalendarDate } from '@/lib/calendar-date';
import { getWorkspaceTimezone } from '@/server/internal/workspace-settings';
import { ConflictError, UserFacingError } from '@/lib/errors';
import { userAction, type ActionResult } from '@/lib/action-result';

/**
 * Get the period status for the session user and a given period start date.
 * Returns draft if no record exists yet.
 */
export async function getPeriodStatus(periodStart: CalendarDate): Promise<PeriodInfo> {
  const actor = await requireSession();
  return getPeriodStatusFor(actor.id, parseCalendarDate(periodStart));
}

/** Resolve a period's day count from its own stored snapshot, falling back to its config. */
async function resolvePeriodNumDays(periodStart: CalendarDate, periodNumDays: number | null): Promise<number> {
  return existingPeriodLength(await getDb(), periodStart, periodNumDays);
}

/**
 * The workspace's "today" and IANA timezone, for the client. D4: the client does no clock math
 * of its own — every late/future-date flag and period landing decision derives from this,
 * refreshed periodically so a tab left open overnight rolls over correctly.
 */
export async function getWorkspaceContext(): Promise<{ today: CalendarDate; timezone: string }> {
  await requireSession();
  const timezone = await getWorkspaceTimezone();
  return { today: await getWorkspaceToday(), timezone };
}

export interface PeriodOption {
  start: CalendarDate;
  numDays: number;
  label: string;
}

/**
 * List period options around a given day — `before` periods back, `after` periods forward,
 * plus the period containing `aroundDay` itself. Each is resolved under ITS OWN effective
 * config (via the same two-sided snap as getNeighborPeriod), so the list is correct across a
 * pay-schedule change instead of assuming every period shares one schedule. D4: the client uses
 * this instead of computing period boundaries itself (fixes the selector's history across
 * schedule changes and the hard-coded semimonthly reports dropdown).
 */
const MAX_PERIOD_OPTIONS_EACH_WAY = 60;

export async function getPeriodOptions(aroundDay: CalendarDate, before: number, after: number): Promise<PeriodOption[]> {
  await requireSession();
  const day = parseCalendarDate(aroundDay);
  // Bounded: this is a public endpoint, and each step is work on the server.
  for (const [name, n] of [['before', before], ['after', after]] as const) {
    if (!Number.isInteger(n) || n < 0 || n > MAX_PERIOD_OPTIONS_EACH_WAY) {
      throw new UserFacingError(`${name} must be an integer from 0 to ${MAX_PERIOD_OPTIONS_EACH_WAY}.`);
    }
  }

  // One query for the whole schedule history, then everything resolves in memory.
  const schedule = await loadScheduleResolver(await getDb());
  const toOption = (p: { start: CalendarDate; numDays: number }): PeriodOption => ({
    start: p.start,
    numDays: p.numDays,
    label: `${formatCalendarDate(p.start, 'MMM D')} – ${formatCalendarDate(addDays(p.start, p.numDays - 1), 'MMM D, YYYY')}`,
  });

  const center = schedule.periodContaining(day);
  const options: PeriodOption[] = [toOption(center)];

  let cursor = center;
  for (let i = 0; i < before; i++) {
    cursor = schedule.neighbor(cursor.start, 'prev');
    options.unshift(toOption(cursor));
  }
  cursor = center;
  for (let i = 0; i < after; i++) {
    cursor = schedule.neighbor(cursor.start, 'next');
    options.push(toOption(cursor));
  }

  return options;
}

/**
 * Email the reviewers of a just-submitted period (first submission or re-submission): exactly the users who may approve
 * it now (feature-plan-certified-outputs.md C2 — admins, the effective designee, CLIN-sharing supervisors for an
 * employee-role submitter), never the submitter, each only if opted in. See src/server/internal/submission-notify.ts.
 */
async function notifyReviewersOfSubmission(userId: string, periodStart: CalendarDate, numDays: number, submittedAt: Date | null): Promise<void> {
  await notifySubmissionRecipients({ employeeId: userId, periodStart, numDays, submittedAt });
}

/**
 * Submit a timesheet period (employee certification) for the session user.
 * Creates the period record if it doesn't exist, or updates status to 'submitted'.
 */
export async function submitPeriod(data: {
  periodStart: CalendarDate;
  comment?: string;
  completeness?: unknown; // structured warnings snapshot from the client (advisory)
}): Promise<ActionResult<PeriodInfo>> {
  return userAction(async () => {
    const actor = await requireSession();
    const userId = actor.id;
    const db = await getDbForWrite();
    const periodStart = parseCalendarDate(data.periodStart);

    // Must be a real period start (same rule as saveTimesheetBatch), so a submission can't
    // certify — and lock — an arbitrary date range. Also resolves the config this period
    // belongs to (the new one, for the first period of a schedule change).
    const { config: periodConfig, numDays } = await resolvePeriod(periodStart);

    // Server-side validation: cannot submit before the last WEEKDAY of the period, per the
    // WORKSPACE's today (never the browser's — a user could spoof their clock to submit early).
    const lastWeekday = getLastWeekdayInPeriod(periodStart, periodConfig);
    const today = await getWorkspaceToday();
    if (isBefore(today, lastWeekday)) {
      throw new UserFacingError(`Cannot submit before the last day of the pay period (${formatCalendarDate(lastWeekday, 'MMM D, YYYY')}).`);
    }

    // One transaction holding this employee's timesheet lock (shared with saveTimesheetBatch), so a save can't
    // land in this period while it is being certified — including a first submission, where no period row
    // exists yet. The empty check, the status check and the write all see the same state.
    const periodEndExclusive = addDays(periodStart, numDays);
    let row: typeof timesheetPeriods.$inferSelect;
    try {
      row = await db.transaction(async (tx) => {
        // feature-plan-certified-outputs.md §3 lock order: the import-window lock (shared here, exclusive in an import
        // batch) FIRST, then the employee lock — so an import and a first submission serialize and never deadlock.
        await lockImportWindowShared(tx);
        await lockEmployeeTimesheet(tx, userId);

        // Server-side validation: cannot submit a completely empty timesheet
        const entryCount = await tx
          .select({ count: sql<number>`COUNT(*)` })
          .from(timesheetEntries)
          .where(
            and(
              eq(timesheetEntries.userId, userId),
              gte(timesheetEntries.entryDate, periodStart),
              lt(timesheetEntries.entryDate, periodEndExclusive),
            )
          );
        if (Number(entryCount[0]?.count ?? 0) === 0) {
          throw new UserFacingError('Cannot submit an empty timesheet. Please enter your hours before submitting.');
        }

        // periodStart is an exact calendar day (a `date` column), so an exact match finds a resubmission.
        const [existing] = await tx
          .select()
          .from(timesheetPeriods)
          .where(and(eq(timesheetPeriods.userId, userId), eq(timesheetPeriods.periodStart, periodStart)));

        let saved: typeof timesheetPeriods.$inferSelect;
        if (!existing) {
          // First submission — snapshot the config this period belongs to.
          [saved] = await tx.insert(timesheetPeriods).values({
            userId,
            periodStart,
            status: 'submitted',
            submittedAt: new Date(),
            submittedComment: data.comment,
            periodType: periodConfig.periodType,
            periodNumDays: numDays,
            completenessSnapshot: data.completeness ?? null,
            submissionCount: 1, // C2: approve/reject apply to exactly this submitted version
          }).returning();
        } else {
          if (existing.status !== 'draft' && existing.status !== 'rejected') {
            throw new UserFacingError(`Cannot submit period with status "${existing.status}". Only draft or rejected periods can be submitted.`);
          }
          // Conditional on the status we just checked: if a reviewer changed it meanwhile, nothing is written.
          const updated = await tx.update(timesheetPeriods)
            .set({
              status: 'submitted',
              submittedAt: new Date(),
              submittedComment: data.comment,
              reviewedAt: null,
              reviewedBy: null,
              reviewComment: null,
              completenessSnapshot: data.completeness ?? null,
              submissionCount: sql`${timesheetPeriods.submissionCount} + 1`, // C2: a resubmission is a new version
              updatedAt: new Date(),
            })
            .where(and(eq(timesheetPeriods.id, existing.id), inArray(timesheetPeriods.status, ['draft', 'rejected'])))
            .returning();
          if (updated.length === 0) throw new ConflictError(CONCURRENT_REVIEW_MESSAGE);
          saved = updated[0];
        }
        // T8/R11: append-only approval history, written in the same transaction as the period change.
        await tx.insert(periodEvents).values({
          periodId: saved.id, userId, event: 'submitted', actorId: userId,
          comment: data.comment ?? null, completenessSnapshot: data.completeness ?? null,
        });
        // CO-D1: the first submission closes the timesheet-history import window (a no-op once closed).
        await closeImportWindowOnSubmit(tx);
        return saved;
      });
    } catch (err) {
      // Two first submissions for the same period at once: the per-user lock makes this near-impossible, but
      // the unique index is the backstop, and Postgres aborts the transaction on it.
      if (isUniqueViolation(err, 'user_period_unique_idx')) throw new ConflictError(CONCURRENT_REVIEW_MESSAGE);
      throw err;
    }

    const result = {
      id: row.id,
      status: 'submitted' as PeriodStatus,
      submittedAt: row.submittedAt,
      reviewedAt: null,
      reviewedBy: null,
      reviewComment: null,
      periodType: row.periodType ?? null,
      periodNumDays: row.periodNumDays ?? null,
    };

    // The submission is already committed; a notification failure must not report it as failed.
    await notifyReviewersOfSubmission(userId, periodStart, numDays, row.submittedAt).catch((err) => console.error('Submission notification failed:', err));

    return result;
  });
}

/** Email the employee about the approval of their period, after the response (scheduleEmail). */
async function notifyEmployeeOfApprove(
  period: { userId: string; periodStart: string; periodNumDays: number | null },
  actorName: string,
): Promise<void> {
  const db = await getDb();
  const [employee] = await db
    .select({ fullName: users.fullName, email: users.email })
    .from(users)
    .where(eq(users.id, period.userId));

  if (employee) {
    const enabled = await isNotificationEnabled(period.userId, 'emailOnApprove');
    if (enabled) {
      const periodStart = period.periodStart as CalendarDate;
      const numDays = await resolvePeriodNumDays(periodStart, period.periodNumDays);
      const periodEnd = addDays(periodStart, numDays - 1);
      const periodLabel = `${formatCalendarDate(periodStart, 'MMM D')} – ${formatCalendarDate(periodEnd, 'MMM D, YYYY')}`;

      const approvedAt = formatInstant(new Date(), await getWorkspaceTimezone(), 'MMM D, YYYY h:mm A');
      const appUrl = tenantBaseUrl(await getTenantSlug());
      scheduleEmail('timesheet-approved', () => sendTimesheetApprovedEmail({
        employeeEmail: employee.email,
        employeeName: employee.fullName,
        periodLabel,
        approvedBy: actorName,
        approvedAt,
        appUrl,
      }));
    }
  }
}

/** Email the employee about the rejection of their period, after the response (scheduleEmail). */
async function notifyEmployeeOfReject(
  period: { userId: string; periodStart: string; periodNumDays: number | null },
  actorName: string,
  comment: string,
): Promise<void> {
  const db = await getDb();
  const [employee] = await db
    .select({ fullName: users.fullName, email: users.email })
    .from(users)
    .where(eq(users.id, period.userId));

  if (employee) {
    const enabled = await isNotificationEnabled(period.userId, 'emailOnReject');
    if (enabled) {
      const periodStart = period.periodStart as CalendarDate;
      const numDays = await resolvePeriodNumDays(periodStart, period.periodNumDays);
      const periodEnd = addDays(periodStart, numDays - 1);
      const periodLabel = `${formatCalendarDate(periodStart, 'MMM D')} – ${formatCalendarDate(periodEnd, 'MMM D, YYYY')}`;

      const rejectedAt = formatInstant(new Date(), await getWorkspaceTimezone(), 'MMM D, YYYY h:mm A');
      const appUrl = tenantBaseUrl(await getTenantSlug());
      const rejectionComment = comment;
      scheduleEmail('timesheet-rejected', () => sendTimesheetRejectedEmail({
        employeeEmail: employee.email,
        employeeName: employee.fullName,
        periodLabel,
        rejectedBy: actorName,
        rejectedAt,
        rejectionComment,
        appUrl,
      }));
    }
  }
}

/** Shown when a period's status changed between our check and our write (another tab or reviewer). */
const CONCURRENT_REVIEW_MESSAGE = 'This timesheet was just changed by someone else. Please refresh and try again.';
/** C2: the employee resubmitted after the reviewer opened it — the reviewer must look at the new version. */
const RESUBMITTED_MESSAGE = 'This timesheet was resubmitted after you opened it — refresh to review the new version.';
const SELF_APPROVAL_OFF_MESSAGE = 'Your timesheet must be approved by another admin or your designated approver.';
const MISSING_SEEN_MESSAGE = 'Open the timesheet and review it before deciding (the reviewed version is missing).';

type Decision = 'approved' | 'rejected';

/**
 * Approve or reject (feature-plan-certified-outputs.md C2). Order: fresh approver (in the exported action) → load period → non-admin
 * self-decision refused (explicit) → admin self-decision refused once a second active admin or an effective designee
 * exists (explicit) → canApprove false → "not found" (no disclosure) → status → the conditional UPDATE on
 * status = 'submitted' AND submission_count = seen (approve exactly what was reviewed). A self-approval event carries
 * approval_context (CO-D19).
 */
async function decidePeriod(
  actor: Awaited<ReturnType<typeof requireApproverFresh>>,
  decision: Decision,
  data: { periodId: string; comment?: string; seen?: number },
): Promise<void> {
  if (typeof data.seen !== 'number' || !Number.isInteger(data.seen) || data.seen < 0) {
    throw new UserFacingError(MISSING_SEEN_MESSAGE);
  }
  const db = await getDbForWrite();
  const [period] = await db.select().from(timesheetPeriods).where(eq(timesheetPeriods.id, data.periodId));
  if (!period) throw new UserFacingError('Period not found', 'not_found');
  const verb = decision === 'approved' ? 'approve' : 'reject';

  const self = period.userId === actor.id;
  if (self && actor.role !== 'admin') {
    // Their own period, so there's nothing to mask: say plainly why it's refused (R2-7).
    throw new AuthorizationError('forbidden', `Forbidden: You cannot ${verb} your own timesheet.`);
  }
  const facts = await loadApprovalFacts(db);
  if (self && !selfApprovalAvailable(facts, actor.id)) {
    throw new AuthorizationError('forbidden', SELF_APPROVAL_OFF_MESSAGE);
  }
  // R2-12: an out-of-scope or not-approvable period looks exactly like a missing one.
  if (!canApprove(facts, actor.id, period.userId)) throw new UserFacingError('Period not found', 'not_found');

  if (period.status !== 'submitted') {
    throw new UserFacingError(`Cannot ${verb} period with status "${period.status}". Only submitted periods can be ${decision}.`);
  }

  await db.transaction(async (tx) => {
    // F1: wait for any in-flight user-rules writer (role / is_active / approver_id), then decide on the rules as they
    // are NOW — the checks above only fail fast; these are the ones that count.
    await lockUserRulesShared(tx);
    const current = await loadApprovalFacts(tx);
    if (self && !selfApprovalAvailable(current, actor.id)) throw new AuthorizationError('forbidden', SELF_APPROVAL_OFF_MESSAGE);
    if (!canApprove(current, actor.id, period.userId)) throw new UserFacingError('Period not found', 'not_found');
    const updated = await tx.update(timesheetPeriods)
      .set({
        status: decision,
        reviewedAt: new Date(),
        reviewedBy: actor.id,
        reviewComment: data.comment ?? null,
        updatedAt: new Date(),
      })
      // Only if still submitted AND still the version the reviewer saw.
      .where(and(eq(timesheetPeriods.id, data.periodId), eq(timesheetPeriods.status, 'submitted'), eq(timesheetPeriods.submissionCount, data.seen!)))
      .returning({ id: timesheetPeriods.id });
    if (updated.length === 0) {
      const [now] = await tx.select({ status: timesheetPeriods.status, submissionCount: timesheetPeriods.submissionCount })
        .from(timesheetPeriods).where(eq(timesheetPeriods.id, data.periodId));
      if (now?.status === 'submitted' && now.submissionCount > data.seen!) throw new ConflictError(RESUBMITTED_MESSAGE);
      throw new ConflictError(CONCURRENT_REVIEW_MESSAGE);
    }
    // T8/R11: append-only approval history, written in the same transaction as the period change.
    await tx.insert(periodEvents).values({
      periodId: data.periodId, userId: period.userId, event: decision, actorId: actor.id,
      comment: data.comment ?? null, completenessSnapshot: period.completenessSnapshot ?? null,
      approvalContext: self && decision === 'approved' ? await selfApprovalContext(tx, actor.id) : null,
    });
  });

  // The decision is already committed; a notification failure must not report it as failed (audit A12).
  if (decision === 'approved') {
    await notifyEmployeeOfApprove(period, actor.fullName).catch((err) => console.error('Approve notification failed:', err));
  } else {
    await notifyEmployeeOfReject(period, actor.fullName, data.comment ?? '').catch((err) => console.error('Reject notification failed:', err));
  }
}

/**
 * Approve a timesheet period. `seen` = the submission_count the reviewer saw (getTimesheetForReview returns it).
 */
export async function approvePeriod(data: {
  periodId: string;
  comment?: string;
  seen: number;
}): Promise<ActionResult<void>> {
  return userAction(async () => {
    const actor = await requireApproverFresh();
    await decidePeriod(actor, 'approved', data);
  });
}

/**
 * Reject a timesheet period so the employee can re-edit and resubmit. A comment is required.
 */
export async function rejectPeriod(data: {
  periodId: string;
  comment: string; // Required for rejections
  seen: number;
}): Promise<ActionResult<void>> {
  return userAction(async () => {
    const actor = await requireApproverFresh();
    await decidePeriod(actor, 'rejected', data);
  });
}

export interface ScopedPeriodRow {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  periodStart: CalendarDate;
  periodNumDays: number;
  status: PeriodStatus;
  submittedAt: Date | null;
  reviewedAt: Date | null;
  reviewedBy: string | null;
  /** C2: whether the session user may approve/reject it now (false → "view but not approve"). */
  canApprove: boolean;
  /** C2: approvalLabel() — badge ("Self-approved"/"Self-rejected") and the approval line. */
  approvalBadge: string | null;
  approvalText: string | null;
}

/**
 * Get all timesheet periods in the approver's review scope (feature-plan-certified-outputs.md C2: CLIN sharers +
 * designators + self; all for admins), each with whether the session user may decide it.
 */
export async function getScopedPeriods(): Promise<ScopedPeriodRow[]> {
  const actor = await requireApprover();
  const scope = await getEmployeeScope(actor);
  const db = await getDb();

  const whereClause = scope === 'all' ? undefined : inArray(timesheetPeriods.userId, scope);
  if (scope !== 'all' && scope.length === 0) return [];

  const rows = await db
    .select({
      id: timesheetPeriods.id,
      userId: timesheetPeriods.userId,
      userName: users.fullName,
      userEmail: users.email,
      periodStart: timesheetPeriods.periodStart,
      periodNumDays: timesheetPeriods.periodNumDays,
      status: timesheetPeriods.status,
      submittedAt: timesheetPeriods.submittedAt,
      reviewedAt: timesheetPeriods.reviewedAt,
      reviewedBy: timesheetPeriods.reviewedBy,
    })
    .from(timesheetPeriods)
    .innerJoin(users, eq(timesheetPeriods.userId, users.id))
    .where(whereClause)
    .orderBy(timesheetPeriods.submittedAt);

  const facts = await loadApprovalFacts(db);
  const labels = await approvalLabels(db, rows, await getWorkspaceTimezone());
  return Promise.all(rows.map(async (row) => ({
    ...row,
    periodStart: row.periodStart as CalendarDate,
    periodNumDays: await resolvePeriodNumDays(row.periodStart as CalendarDate, row.periodNumDays),
    canApprove: row.status === 'submitted' && canApprove(facts, actor.id, row.userId),
    approvalBadge: labels.get(row.id)?.badge ?? null,
    approvalText: labels.get(row.id)?.text ?? null,
  })));
}

/**
 * Get the session user's own approval-scope info (contract/CLIN/employee counts), for the
 * Approvals page banner. Supervisors only — admins have no "scope" to summarize.
 */
export async function getMyScopeInfo(): Promise<{
  assignedContractCount: number;
  assignedClinCount: number;
  supervisedEmployeeCount: number;
  designatedByCount: number;
} | null> {
  const actor = await requireApprover();
  if (actor.role !== 'supervisor') return null;
  return getSupervisorScopeInfo(actor.id);
}
