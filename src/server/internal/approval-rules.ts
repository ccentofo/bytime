import 'server-only';
import { and, asc, eq, sql } from 'drizzle-orm';
import { getDb, type DbTx, type ReadDb, type TenantWriter } from '@/db';
import { adminChangeLog, timesheetPeriods, userAssignments, users } from '@/db/schema';
import { logAdminChange } from './admin-change-log';

/**
 * Approver rules (feature-plan-certified-outputs.md C2 — CO-D5, CO-D6, CO-D9, CO-D12, CO-D18, CO-D19). INTERNAL:
 * callers authorize first. The rules are pure functions over one snapshot of the workspace's users and active CLIN
 * assignments (`ApprovalFacts`), so the review scope, the approve check, the submission-email recipients and the
 * self-approval switch can never disagree.
 *
 * - effectiveDesignee(E): E.approverId, honoured only while E is supervisor/admin and the designee is ACTIVE with role
 *   admin/supervisor (and not E) — otherwise null (the supervisee falls back to admins).
 * - canApprove(A, E): self → only an admin, with no other active admin and no effective designee (CO-D6/CO-D12);
 *   another admin → yes; a supervisor → E's effective designee, or E is employee-role and shares an active CLIN with A.
 * - reviewScope(A): admin → all; supervisor → CLIN sharers ∪ the users who effectively designated A ∪ A (CO-D18: a
 *   supervisor with no CLINs sees exactly {self, their designators}); anyone else → [] (self access is separate).
 */

export type Role = 'admin' | 'supervisor' | 'employee';

export interface ApprovalUser {
  id: string;
  role: Role;
  isActive: boolean;
  approverId: string | null;
}

export interface ApprovalFacts {
  users: Map<string, ApprovalUser>;
  /** Active CLIN assignments: userId → CLIN ids. */
  clinsByUser: Map<string, Set<string>>;
}

/**
 * certified-outputs fix round 1 (F1): the user-rules lock. Every writer of users.role / users.is_active /
 * users.approver_id takes it EXCLUSIVELY as the FIRST statement of its transaction (before any row lock), so those
 * writers serialize — no opposite-order row-lock deadlocks, and recomputeSelfApproval always sees the previous writer's
 * committed result (every switch is logged, CO-D19). approve/reject take it SHARED inside the decision transaction and
 * re-run canApprove there, so a decision never lands on rules that changed while it waited.
 */
const USER_RULES_LOCK = 'user-rules';

export async function lockUserRulesExclusive(tx: Pick<DbTx, 'execute'>): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${USER_RULES_LOCK}))`);
}

export async function lockUserRulesShared(tx: Pick<DbTx, 'execute'>): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(hashtext(${USER_RULES_LOCK}))`);
}

export async function loadApprovalFacts(db: Pick<ReadDb, 'select'> | TenantWriter): Promise<ApprovalFacts> {
  const rows = await db.select({ id: users.id, role: users.role, isActive: users.isActive, approverId: users.approverId }).from(users);
  const assignments = await db.select({ userId: userAssignments.userId, clinId: userAssignments.clinId })
    .from(userAssignments).where(eq(userAssignments.isActive, true));
  const clinsByUser = new Map<string, Set<string>>();
  for (const a of assignments) {
    if (!clinsByUser.has(a.userId)) clinsByUser.set(a.userId, new Set());
    clinsByUser.get(a.userId)!.add(a.clinId);
  }
  return { users: new Map(rows.map((u) => [u.id, u])), clinsByUser };
}

const isApproverRole = (role: Role) => role === 'admin' || role === 'supervisor';

export function effectiveDesignee(facts: ApprovalFacts, employeeId: string): string | null {
  const employee = facts.users.get(employeeId);
  if (!employee || !employee.approverId || !isApproverRole(employee.role)) return null;
  const designee = facts.users.get(employee.approverId);
  if (!designee || designee.id === employee.id || !designee.isActive || !isApproverRole(designee.role)) return null;
  return designee.id;
}

export function activeAdminIds(facts: ApprovalFacts): string[] {
  return [...facts.users.values()].filter((u) => u.role === 'admin' && u.isActive).map((u) => u.id);
}

/** CO-D19: an admin may self-approve iff active, the only active admin, and without an effective designee. */
export function selfApprovalAvailable(facts: ApprovalFacts, adminId: string): boolean {
  const admin = facts.users.get(adminId);
  if (!admin || admin.role !== 'admin' || !admin.isActive) return false;
  return activeAdminIds(facts).every((id) => id === adminId) && effectiveDesignee(facts, adminId) === null;
}

export function sharesActiveClin(facts: ApprovalFacts, a: string, b: string): boolean {
  const ca = facts.clinsByUser.get(a);
  const cb = facts.clinsByUser.get(b);
  if (!ca || !cb) return false;
  for (const c of ca) if (cb.has(c)) return true;
  return false;
}

/** The actor's role and active state come from the snapshot (fresh), never the session token. */
export function canApprove(facts: ApprovalFacts, actorId: string, employeeId: string): boolean {
  const actor = facts.users.get(actorId);
  const employee = facts.users.get(employeeId);
  if (!actor || !actor.isActive || !employee) return false;
  if (actorId === employeeId) return actor.role === 'admin' && selfApprovalAvailable(facts, actorId);
  if (actor.role === 'admin') return true;
  if (actor.role === 'supervisor') {
    return effectiveDesignee(facts, employeeId) === actorId || (employee.role === 'employee' && sharesActiveClin(facts, actorId, employeeId));
  }
  return false;
}

export function reviewScopeFrom(facts: ApprovalFacts, actorId: string): 'all' | string[] {
  const actor = facts.users.get(actorId);
  if (!actor || !actor.isActive) return [];
  if (actor.role === 'admin') return 'all';
  if (actor.role !== 'supervisor') return [];
  const scope = new Set<string>([actorId]);
  const mine = facts.clinsByUser.get(actorId);
  if (mine) {
    for (const [userId, clins] of facts.clinsByUser) {
      for (const c of clins) if (mine.has(c)) { scope.add(userId); break; }
    }
  }
  for (const u of facts.users.values()) if (effectiveDesignee(facts, u.id) === actorId) scope.add(u.id);
  return [...scope];
}

/** Everyone who may decide `employeeId`'s timesheet right now, never the employee themselves. */
export function eligibleApprovers(facts: ApprovalFacts, employeeId: string): string[] {
  return [...facts.users.values()]
    .filter((u) => u.id !== employeeId && isApproverRole(u.role) && canApprove(facts, u.id, employeeId))
    .map((u) => u.id);
}

/** The review scope of a (session) actor, from a fresh snapshot. */
export async function reviewScope(actor: { id: string }, db?: Pick<ReadDb, 'select'>): Promise<'all' | string[]> {
  return reviewScopeFrom(await loadApprovalFacts(db ?? await getDb()), actor.id);
}

// ── Self-approval switch (CO-D19) ─────────────────────────────────────────────

export interface SelfApprovalChange {
  adminId: string;
  enabled: boolean;
  logId: string;
}

/** The latest recorded self-approval state per admin (entity 'self_approval'); absent = never enabled. */
async function lastSelfApprovalState(db: Pick<ReadDb, 'select'> | TenantWriter): Promise<Map<string, { enabled: boolean; at: Date; by: string; id: string }>> {
  const rows = await db.select().from(adminChangeLog)
    .where(eq(adminChangeLog.entity, 'self_approval'))
    .orderBy(asc(adminChangeLog.createdAt), asc(adminChangeLog.id));
  const last = new Map<string, { enabled: boolean; at: Date; by: string; id: string }>();
  for (const r of rows) last.set(r.entityId, { enabled: r.action === 'enabled', at: r.createdAt, by: r.actorId, id: r.id });
  return last;
}

/**
 * Compare every admin's self-approval availability with the last recorded state and write one admin_change_log row per
 * change (`enabled`/`disabled`, with the reason and the active-admin count). Call in the SAME transaction as every write
 * that changes users.role, users.is_active or users.approver_id (a static test checks the writers).
 */
export async function recomputeSelfApproval(
  tx: TenantWriter,
  actorId: string,
  reason: string,
  /** Fix round 2, R2: the facts BEFORE the write (writers pass them; baselines — provisioning, the seeder — don't). */
  opts: { before?: ApprovalFacts } = {},
): Promise<SelfApprovalChange[]> {
  const facts = await loadApprovalFacts(tx);
  const last = await lastSelfApprovalState(tx);
  const candidates = new Set<string>([
    ...[...facts.users.values()].filter((u) => u.role === 'admin').map((u) => u.id),
    ...[...last.entries()].filter(([, s]) => s.enabled).map(([id]) => id),
  ]);
  const activeAdminCount = activeAdminIds(facts).length;
  const changes: SelfApprovalChange[] = [];
  for (const adminId of [...candidates].sort()) {
    const now = selfApprovalAvailable(facts, adminId);
    const prior = last.get(adminId);
    const before = prior?.enabled ?? false;
    if (now === before) continue;
    // R2: an admin with NO record yet whose self-approval was already available before this write (a workspace from
    // before C2) — this row records the existing state; it is not a switch, so it carries a baseline reason (no notice).
    const existingState = !prior && now && opts.before !== undefined && selfApprovalAvailable(opts.before, adminId);
    const logId = await logAdminChange(tx, {
      actorId,
      entity: 'self_approval',
      entityId: adminId,
      action: now ? 'enabled' : 'disabled',
      oldValue: { enabled: before },
      newValue: { enabled: now, reason: existingState ? EXISTING_STATE_REASON : reason, activeAdminCount },
    });
    changes.push({ adminId, enabled: now, logId });
  }
  return changes;
}

/** CO-D19: written on a self-approval event — the facts at that moment and the last switch-on. */
export async function selfApprovalContext(tx: TenantWriter, adminId: string): Promise<Record<string, unknown>> {
  const facts = await loadApprovalFacts(tx);
  const enabledRows = await tx.select({ createdAt: adminChangeLog.createdAt, actorId: adminChangeLog.actorId }).from(adminChangeLog)
    .where(and(eq(adminChangeLog.entity, 'self_approval'), eq(adminChangeLog.entityId, adminId), eq(adminChangeLog.action, 'enabled')))
    .orderBy(asc(adminChangeLog.createdAt));
  const lastOn = enabledRows[enabledRows.length - 1];
  return {
    selfApproved: true,
    activeAdminCount: activeAdminIds(facts).length,
    effectiveDesignee: effectiveDesignee(facts, adminId),
    selfApprovalEnabledAt: lastOn?.createdAt.toISOString() ?? null,
    selfApprovalEnabledBy: lastOn?.actorId ?? null,
  };
}

/** Reasons written by a baseline recompute (provisioning, the demo seeder) — not a switch the admin needs to hear about. */
/** R2: the first row for an admin whose self-approval was already on (pre-C2 workspace) — recorded, not switched. */
export const EXISTING_STATE_REASON = 'existing state recorded';
export const BASELINE_SELF_APPROVAL_REASONS = ['workspace created', 'demo workspace seeded', EXISTING_STATE_REASON];

/**
 * For the "Self-approval is back on" notice: the log row that switched this admin's self-approval ON, when it is on now,
 * the latest self_approval row for the admin is `enabled`, and that row is not a baseline (fix round 1, F2: no earlier
 * "disabled" row is needed — workspaces from before C2 have none).
 */
export async function currentSelfApprovalOn(db: Pick<ReadDb, 'select'>, adminId: string): Promise<{ logId: string; at: Date } | null> {
  const facts = await loadApprovalFacts(db);
  if (!selfApprovalAvailable(facts, adminId)) return null;
  const rows = await db.select({ id: adminChangeLog.id, action: adminChangeLog.action, createdAt: adminChangeLog.createdAt, newValue: adminChangeLog.newValue })
    .from(adminChangeLog)
    .where(and(eq(adminChangeLog.entity, 'self_approval'), eq(adminChangeLog.entityId, adminId)))
    .orderBy(asc(adminChangeLog.createdAt), asc(adminChangeLog.id));
  const last = rows[rows.length - 1];
  if (!last || last.action !== 'enabled') return null;
  const reason = (last.newValue as { reason?: unknown } | null)?.reason;
  return typeof reason === 'string' && BASELINE_SELF_APPROVAL_REASONS.includes(reason) ? null : { logId: last.id, at: last.createdAt };
}

// ── Re-routing (CO-D19) ───────────────────────────────────────────────────────

export type EligibilitySnapshot = Map<string, { userId: string; approvers: Set<string>; designee: string | null }>;

/** Who may decide each SUBMITTED period right now, and the submitter's effective designee. */
export async function snapshotSubmittedEligibility(tx: Pick<ReadDb, 'select'> | TenantWriter, known?: ApprovalFacts): Promise<EligibilitySnapshot> {
  const facts = known ?? await loadApprovalFacts(tx);
  const submitted = await tx.select({ id: timesheetPeriods.id, userId: timesheetPeriods.userId })
    .from(timesheetPeriods).where(eq(timesheetPeriods.status, 'submitted'));
  return new Map(submitted.map((p) => [p.id, {
    userId: p.userId,
    approvers: new Set(eligibleApprovers(facts, p.userId)),
    designee: effectiveDesignee(facts, p.userId),
  }]));
}

export const DESIGNEE_LOST_NOTE = 'Its designated approver is no longer available.';

export interface ReroutedApproval {
  periodId: string;
  userId: string;
  recipients: string[];
  /** Ruling Q8: the timesheet lost its effective designee — every current approver is re-notified, with the note. */
  designeeLost: boolean;
}

/**
 * Re-routing (CO-D19 + ruling Q8), one entry — one email per recipient — per waiting timesheet:
 *  - its eligible-approver set GAINED someone → only the newly eligible are emailed;
 *  - it LOST its effective designee (deactivated, demoted, or the designation removed/changed) → all of its CURRENT
 *    approvers are emailed (they assumed the designee would handle it), with DESIGNEE_LOST_NOTE.
 * The submitter is never a recipient (eligibleApprovers excludes them).
 */
export function newlyEligible(before: EligibilitySnapshot, after: EligibilitySnapshot): ReroutedApproval[] {
  const out: ReroutedApproval[] = [];
  for (const [periodId, now] of after) {
    const was = before.get(periodId);
    const designeeLost = !!was?.designee && was.designee !== now.designee;
    const recipients = [...now.approvers].filter((id) => id !== now.userId && (designeeLost || !was?.approvers.has(id)));
    if (recipients.length) out.push({ periodId, userId: now.userId, recipients, designeeLost });
  }
  return out;
}

/**
 * The people this approver can decide (feature-plan-ux-navigation-home.md §4.5 "teamScope"): their review scope minus
 * themselves, kept only where canApprove is true (relational — period status is checked elsewhere). Peer supervisors
 * or admins who merely share a CLIN are excluded. Home's team status and the Approvals scope sentence both use this.
 */
export function approvableScope(facts: ApprovalFacts, actorId: string): string[] {
  const scope = reviewScopeFrom(facts, actorId);
  const ids = scope === 'all' ? [...facts.users.keys()] : scope;
  return ids.filter((id) => id !== actorId && canApprove(facts, actorId, id));
}

/** The ids among `periodIds` the actor may approve (for lists). */
export function approvableAmong(facts: ApprovalFacts, actorId: string, periods: Array<{ id: string; userId: string }>): Set<string> {
  return new Set(periods.filter((p) => canApprove(facts, actorId, p.userId)).map((p) => p.id));
}

