'use server';

import { getDb, getDbForAuth, getDbForWrite } from '@/db';
import { chargeCodes, userAssignments, userChargeCodes, users, approvalScopes } from '@/db/schema';
import bcrypt from 'bcryptjs';
import { eq, and, notInArray, sql } from 'drizzle-orm';
import { requireAdmin, requireAdminFresh, AuthorizationError } from '@/lib/session';
import { getLockoutsForEmails, unlockAccount } from '@/server/internal/login-attempts';
import { SAFE_USER_COLUMNS } from '@/server/internal/users';
import { assertSeatsAvailable } from '@/server/internal/seats';
import { effectiveDesignee, loadApprovalFacts, lockUserRulesExclusive, newlyEligible, recomputeSelfApproval, snapshotSubmittedEligibility, type ApprovalFacts } from '@/server/internal/approval-rules';
import { approvalNotices } from '@/server/internal/approval-notices';
import { notifyReroutedApprovals } from '@/server/internal/submission-notify';
import { validateEmail, validateRequired, validateStringLength, validateEnum, validateUUID } from '@/lib/validation';
import { UserFacingError } from '@/lib/errors';
import { userAction, type ActionResult } from '@/lib/action-result';
import { logAdminChange } from '@/server/internal/admin-change-log';
import { validatePassword } from '@/lib/password-rules';
import { assertActiveClins, deactivateScopeRows, grantScopeRows } from '@/server/internal/approval-scopes';
import type { DbTx } from '@/db';

const USER_ROLES = ['admin', 'supervisor', 'employee'] as const;

/** List every user. Admin only — includes roles and active state, used to drive user management. */
export async function getUsers() {
  await requireAdmin();
  const db = await getDb();
  return db.select(SAFE_USER_COLUMNS).from(users).orderBy(users.fullName);
}

/** A Users-page row (feature-plan-ux-people-codes.md §5.1): the safe columns plus what the page shows. Never a secret. */
export type AdminPageUser = Awaited<ReturnType<typeof getUsers>>[number] & {
  /** users.totp_enabled, as a boolean only — no TOTP secret or recovery codes leave the server. */
  mfaEnabled: boolean;
  /** Locked by failed sign-ins: minutes left (truncated, > 0), else null. */
  lock: { minutesRemaining: number } | null;
  /** Supervisors and admins: their effective approver's name (the approvals rule), else null. */
  approverName: string | null;
};

/**
 * The Users page's read (§5.1): getUsers' columns plus two-step on/off, the lock (ONE bounded login_attempts query for
 * every email, the same arithmetic as sign-in) and the server-computed approver. getUsers itself is unchanged.
 */
export async function getUsersForAdminPage(): Promise<AdminPageUser[]> {
  await requireAdmin();
  const db = await getDb();
  const rows = await db.select({ ...SAFE_USER_COLUMNS, mfaEnabled: users.totpEnabled }).from(users).orderBy(users.fullName);
  const locks = await getLockoutsForEmails(db, rows.map((r) => r.email));
  const facts: ApprovalFacts = { users: new Map(rows.map((r) => [r.id, { id: r.id, role: r.role, isActive: r.isActive, approverId: r.approverId }])), clinsByUser: new Map(), scopeClinsBySupervisor: new Map() };
  const nameById = new Map(rows.map((r) => [r.id, r.fullName]));
  return rows.map((r) => {
    const lock = r.isActive ? locks.get(r.email.toLowerCase().trim()) : undefined;
    const designee = r.role === 'employee' ? null : effectiveDesignee(facts, r.id);
    return { ...r, mfaEnabled: r.mfaEnabled === true, lock: lock ? { minutesRemaining: lock.minutesRemaining } : null, approverName: designee ? nameById.get(designee) ?? null : null };
  });
}

/** The approver a supervisor or admin may be given: an active admin or supervisor (setUserApprover and the create path). */
async function assertValidApprover(tx: Pick<DbTx, 'select'>, approverId: string): Promise<void> {
  const [approver] = await tx.select({ role: users.role, isActive: users.isActive }).from(users).where(eq(users.id, approverId));
  if (!approver || !approver.isActive || (approver.role !== 'admin' && approver.role !== 'supervisor')) {
    throw new UserFacingError('The approver must be an active admin or supervisor.');
  }
}
const APPROVER_ROLES_ONLY = 'Approvers can be designated for supervisors and admins only. Employees are approved by their CLIN supervisors and admins.';

// ── Approval CLINs on promotion / creation (feature-plan-approval-scope.md §4.2) ──────────────────────────────────
const ALREADY_SUPERVISOR = 'Already a supervisor — edit their approval scope on Assignments.';
const APPROVAL_CLINS_ONLY_FOR_SUPERVISORS = 'Approval CLINs only apply when making someone a supervisor.';

/** `approvalClinIds`: undefined, or 0–200 deduped, lowercased UUIDs. */
function approvalClinList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new UserFacingError('Choose the CLINs they approve.');
  const ids = [...new Set(value.map((id) => validateUUID(id, 'CLIN')))];
  if (ids.length > 200) throw new UserFacingError('Choose 200 CLINs or fewer.');
  return ids;
}

/**
 * S10: a demoted supervisor's CLIN membership rows that no active charge code backs are deactivated (rows the old
 * supervisor-scope action created would otherwise keep them visible, and approvable, on CLINs they only supervised).
 * Returns the CLIN ids deactivated.
 */
async function removeUnbackedMembership(tx: DbTx, userId: string): Promise<string[]> {
  const backed = tx.select({ clinId: chargeCodes.clinId }).from(userChargeCodes)
    .innerJoin(chargeCodes, eq(chargeCodes.id, userChargeCodes.chargeCodeId))
    .where(and(eq(userChargeCodes.userId, userId), eq(userChargeCodes.isActive, true)));
  const rows = await tx.update(userAssignments).set({ isActive: false })
    .where(and(eq(userAssignments.userId, userId), eq(userAssignments.isActive, true), notInArray(userAssignments.clinId, backed)))
    .returning({ clinId: userAssignments.clinId });
  return rows.map((r) => r.clinId).sort();
}

export async function unlockUserAccount(email: string): Promise<ActionResult<void>> {
  return userAction(async () => {
    await requireAdminFresh();
    // Credential bookkeeping through the auth client, as before: an admin can unlock a user in any non-closed mode.
    await unlockAccount(await getDbForAuth(), email);
  });
}

/**
 * Update a user's profile fields. Admin only, with a fresh DB role/active check (R2-8): a
 * demoted or deactivated admin must be denied immediately, not up to 60s later via a cached JWT.
 *
 * R2-6: the write set is built from an explicit allowlist — the request body is never spread
 * into `.set()`, so a caller cannot smuggle in passwordHash, totpEnabled, sessionVersion, or any
 * other column by sending extra JSON fields the TypeScript signature doesn't allow for.
 *
 * The last-active-admin check and the update run in one transaction with the relevant admin
 * rows locked (`FOR UPDATE`), so two concurrent requests can't both see "there's another admin
 * left" and both succeed in removing the last one.
 */
export async function updateUser(id: string, data: {
  fullName?: string;
  email?: string;
  role?: 'admin' | 'supervisor' | 'employee';
  isActive?: boolean;
  flsaExempt?: boolean;
  /**
   * feature-plan-approval-scope.md §4.2: the CLINs they'll approve — ONLY with a real change of role TO supervisor (their
   * approval scope is exactly these; charge code access is unchanged). Refused otherwise.
   */
  approvalClinIds?: string[];
}) {
  return userAction(async () => {
    const actor = await requireAdminFresh();
    id = validateUUID(id, 'User');
    const approvalClinIds = approvalClinList(data.approvalClinIds);
    if (approvalClinIds !== undefined && data.role !== undefined && data.role !== 'supervisor') throw new UserFacingError(APPROVAL_CLINS_ONLY_FOR_SUPERVISORS);   // lowercased: the self checks below compare with `===` (UX-4C1-AUDIT.md L1)
    const db = await getDbForWrite();

    // Server-action arguments are untrusted JSON. The last-admin and self-deactivation checks
    // below key on `isActive === false`, and Postgres would happily coerce "false" or 0 to false,
    // so anything that isn't a real boolean is rejected up front.
    if (data.isActive !== undefined && typeof data.isActive !== 'boolean') {
      throw new UserFacingError('Active status must be true or false.');
    }
    if (data.flsaExempt !== undefined && typeof data.flsaExempt !== 'boolean') {
      throw new UserFacingError('FLSA exempt must be true or false.');
    }
    // Audit R4: role and active status change in separate calls (the UI never sends both). Together, e.g.
    // `{ isActive: true, role: 'employee' }`, the reactivation branch would lock the target before the admin rows —
    // the opposite order to the last-admin lock below, which can deadlock (A3).
    if (data.role !== undefined && data.isActive !== undefined) {
      throw new UserFacingError('Change the role and the active status separately.');
    }

    // An admin cannot change their own role or deactivate themselves.
    if (actor.id === id) {
      if (data.role !== undefined && data.role !== actor.role) {
        throw new AuthorizationError('forbidden', 'Forbidden: You cannot change your own role.');
      }
      if (data.isActive === false) {
        throw new AuthorizationError('forbidden', 'Forbidden: You cannot deactivate your own account.');
      }
    }

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (data.fullName !== undefined) {
      updateData.fullName = validateStringLength(validateRequired(data.fullName, 'Full name'), 'Full name', 1, 255);
    }
    if (data.email !== undefined) {
      updateData.email = validateEmail(data.email);
    }
    if (data.role !== undefined) {
      updateData.role = validateEnum(data.role, 'Role', USER_ROLES);
    }
    if (data.isActive !== undefined) {
      updateData.isActive = data.isActive;
    }
    if (data.flsaExempt !== undefined) {
      updateData.flsaExempt = data.flsaExempt;
    }

    const shouldInvalidateSession = data.role !== undefined || data.isActive !== undefined;
    const demotingRole = data.role !== undefined && data.role !== 'admin';
    const deactivating = data.isActive === false;
    const activating = data.isActive === true;

    const result = await db.transaction(async (tx) => {
      await lockUserRulesExclusive(tx); // F1: first statement, before any row lock
      // feature-plan-ux-people-codes.md R5: the old values, for the change log (a plain read; the lock order is unchanged).
      const [old] = await tx.select({ role: users.role, isActive: users.isActive, flsaExempt: users.flsaExempt }).from(users).where(eq(users.id, id));
      if (!old) throw new UserFacingError('User not found.', 'not_found');
      if (activating) {
        // Reactivating a user takes a seat, same as creating one (R2-11).
        const [target] = await tx.select({ isActive: users.isActive }).from(users).where(eq(users.id, id)).for('update');
        if (target && !target.isActive) await assertSeatsAvailable(1, tx);
      }

      if (demotingRole || deactivating) {
        // Lock EVERY active admin row in one statement, in id order (launch-blockers audit A3). Two admins demoting
        // each other then queue on the same rows in the same order — never the opposite-order deadlock (40P01) of
        // "lock the target, then the others" — and the waiter re-reads under READ COMMITTED, so it no longer counts
        // the admin the first transaction just demoted and gets the last-admin refusal.
        const activeAdmins = await tx
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.role, 'admin'), eq(users.isActive, true)))
          .orderBy(users.id)
          .for('update');
        const [target] = await tx
          .select({ role: users.role, isActive: users.isActive })
          .from(users)
          .where(eq(users.id, id))
          .for('update');

        if (target?.role === 'admin' && target.isActive) {
          const otherActiveAdmins = activeAdmins.filter((a) => a.id !== id);
          if (otherActiveAdmins.length === 0) {
            throw new AuthorizationError('forbidden', 
              demotingRole
                ? 'Forbidden: Cannot change the role of the last active admin.'
                : 'Forbidden: Cannot deactivate the last active admin.'
            );
          }
        }
      }

      // feature-plan-approval-scope.md §4.2 (after the lock and the sole-admin refusal): approval CLINs only with a real
      // change TO supervisor, and only active CLINs on active contracts. Promoting an inactive user is allowed.
      const promoting = data.role === 'supervisor' && old.role !== 'supervisor';
      const demoting = data.role !== undefined && data.role !== 'supervisor' && old.role === 'supervisor';
      if (approvalClinIds !== undefined && !promoting) {
        throw new UserFacingError(old.role === 'supervisor' ? ALREADY_SUPERVISOR : APPROVAL_CLINS_ONLY_FOR_SUPERVISORS);
      }
      const chosenClins = promoting ? approvalClinIds ?? [] : [];
      if (promoting) await assertActiveClins(tx, chosenClins);

      if (shouldInvalidateSession) {
        // Increment in SQL so two concurrent edits can't both write the same bumped value.
        updateData.sessionVersion = sql`${users.sessionVersion} + 1`;
      }

      // certified-outputs C2 (CO-D19): self-approval switch + re-routing, in this same transaction.
      const beforeFacts = await loadApprovalFacts(tx);
      const before = await snapshotSubmittedEligibility(tx, beforeFacts);
      const rows = await tx.update(users).set(updateData).where(eq(users.id, id)).returning(SAFE_USER_COLUMNS);
      const changed = rows[0];
      // feature-plan-approval-scope.md §4.2: approval scope follows a real role change — inside this transaction and lock,
      // after the before-snapshot and before the after-snapshot (so waiting timesheets re-route).
      let membershipRemoved: string[] | undefined;
      if (changed && promoting) {
        // Exactly the chosen CLINs: any other active scope row goes (logged), the chosen ones are granted (logged when new).
        const stale = await tx.select({ id: approvalScopes.id }).from(approvalScopes)
          .where(and(eq(approvalScopes.supervisorId, id), eq(approvalScopes.isActive, true),
            ...(chosenClins.length > 0 ? [notInArray(approvalScopes.clinId, chosenClins)] : [])));
        await deactivateScopeRows(tx, { actorId: actor.id, rowIds: stale.map((r) => r.id) });
        await grantScopeRows(tx, { actorId: actor.id, supervisorId: id, clinIds: chosenClins, source: 'app' });
      }
      if (changed && demoting) {
        const scope = await tx.select({ id: approvalScopes.id }).from(approvalScopes)
          .where(and(eq(approvalScopes.supervisorId, id), eq(approvalScopes.isActive, true)));
        await deactivateScopeRows(tx, { actorId: actor.id, rowIds: scope.map((r) => r.id) });
        membershipRemoved = await removeUnbackedMembership(tx, id);
      }
      // R5: log only what actually changed, in this transaction (a failed log rolls the change back).
      if (data.role !== undefined && changed && changed.role !== old.role) {
        // A promotion records the CLINs chosen (their whole approval scope); a demotion the CLIN rows removed (S10).
        const newValue = promoting ? { role: changed.role, clinIds: [...chosenClins].sort() }
          : membershipRemoved ? { role: changed.role, membershipRemoved }
          : { role: changed.role };
        await logAdminChange(tx, {
          actorId: actor.id, entity: 'user', entityId: id, action: 'role_changed',
          oldValue: { role: old.role }, newValue,
        });
      }
      if (data.isActive !== undefined && changed && changed.isActive !== old.isActive) {
        await logAdminChange(tx, {
          actorId: actor.id, entity: 'user', entityId: id, action: changed.isActive ? 'reactivated' : 'deactivated',
          oldValue: { isActive: old.isActive }, newValue: { isActive: changed.isActive },
        });
      }
      if (data.flsaExempt !== undefined && changed && changed.flsaExempt !== old.flsaExempt) {
        await logAdminChange(tx, {
          actorId: actor.id, entity: 'user', entityId: id, action: 'flsa_changed',
          oldValue: { flsaExempt: old.flsaExempt }, newValue: { flsaExempt: changed.flsaExempt },
        });
      }
      const reason = !changed ? 'user update'
        : data.isActive === false ? `${changed.fullName} deactivated`
        : data.isActive === true ? `${changed.fullName} reactivated`
        : data.role !== undefined ? `${changed.fullName}'s role changed to ${changed.role}`
        : `${changed.fullName} updated`;
      await recomputeSelfApproval(tx, actor.id, reason, { before: beforeFacts });
      return { row: changed, rerouted: newlyEligible(before, await snapshotSubmittedEligibility(tx)) };
    });

    await notifyReroutedApprovals(result.rerouted);
    return result.row;
  });
}

/**
 * Add a user with a temporary password (feature-plan-ux-people-codes.md R7, §5.1): the overtime status is required
 * (no default), the password follows password-rules.ts, the email is validated, and an approver may be set only for a
 * supervisor or admin. Logs `created` (role, overtime status), plus `approver_changed` when an approver is set. A
 * duplicate email is the existing friendly `conflict` (userAction).
 */
export async function createUserWithPassword(data: {
  email: string;
  fullName: string;
  role: 'admin' | 'supervisor' | 'employee';
  password: string;
  flsaExempt: boolean;
  approverId?: string | null;
  /** feature-plan-approval-scope.md §4.2: a new supervisor's approval CLINs (optional; supervisors only). */
  approvalClinIds?: string[];
}) {
  return userAction(async () => {
    const actor = await requireAdminFresh();
    const db = await getDbForWrite();
    const validatedEmail = validateEmail(data.email);
    const validatedName = validateStringLength(validateRequired(data.fullName, 'Full name'), 'Full name', 1, 255);
    const validatedRole = validateEnum(data.role, 'Role', USER_ROLES);
    if (typeof data.flsaExempt !== 'boolean') throw new UserFacingError('Choose an overtime status.');
    const passwordError = validatePassword(data.password);
    if (passwordError) throw new UserFacingError(passwordError);
    const approverId = data.approverId ? validateUUID(data.approverId, 'Approver') : null;
    if (approverId && validatedRole === 'employee') throw new UserFacingError(APPROVER_ROLES_ONLY);
    const approvalClinIds = approvalClinList(data.approvalClinIds);
    if (approvalClinIds !== undefined && validatedRole !== 'supervisor') throw new UserFacingError(APPROVAL_CLINS_ONLY_FOR_SUPERVISORS);
    const hash = await bcrypt.hash(data.password, 12);
    // certified-outputs C2 (ruling Q5): one transaction with the self-approval recompute and re-routing snapshot.
    const { user, rerouted } = await db.transaction(async (tx) => {
      await lockUserRulesExclusive(tx); // F1: first statement, before any row lock
      await assertSeatsAvailable(1, tx);
      if (approverId) await assertValidApprover(tx, approverId);
      if (approvalClinIds) await assertActiveClins(tx, approvalClinIds);
      const beforeFacts = await loadApprovalFacts(tx);
      const before = await snapshotSubmittedEligibility(tx, beforeFacts);
      const [row] = await tx.insert(users).values({
        email: validatedEmail,
        fullName: validatedName,
        role: validatedRole,
        passwordHash: hash,
        flsaExempt: data.flsaExempt,
        approverId,
      }).returning(SAFE_USER_COLUMNS);
      await logAdminChange(tx, { actorId: actor.id, entity: 'user', entityId: row.id, action: 'created', oldValue: null, newValue: { role: row.role, flsaExempt: row.flsaExempt } });
      if (approverId) {
        await logAdminChange(tx, { actorId: actor.id, entity: 'user', entityId: row.id, action: 'approver_changed', oldValue: { approverId: null }, newValue: { approverId } });
      }
      if (approvalClinIds) await grantScopeRows(tx, { actorId: actor.id, supervisorId: row.id, clinIds: approvalClinIds, source: 'app' });
      await recomputeSelfApproval(tx, actor.id, `${row.fullName} added (${row.role})`, { before: beforeFacts });
      return { user: row, rerouted: newlyEligible(before, await snapshotSubmittedEligibility(tx)) };
    });
    await notifyReroutedApprovals(rerouted);
    return user;
  });
}

/**
 * Designate (or clear) the approver of a supervisor- or admin-role user (feature-plan-certified-outputs.md C2,
 * CO-D5/CO-D12). Options: an active admin or supervisor other than the user. Logged to admin_change_log, the
 * self-approval switch recomputed and the waiting timesheets re-routed, all in one transaction. Demoting or
 * deactivating the approver later leaves approver_id set but ineffective (approval-rules.ts effectiveDesignee).
 */
export async function setUserApprover(userId: string, approverId: string | null): Promise<ActionResult<{ approverId: string | null }>> {
  return userAction(async () => {
    const actor = await requireAdminFresh();
    const db = await getDbForWrite();
    if (approverId !== null && typeof approverId !== 'string') throw new UserFacingError('Choose an approver or none.');
    if (approverId === userId) throw new UserFacingError('A user cannot be their own approver.');

    const rerouted = await db.transaction(async (tx) => {
      await lockUserRulesExclusive(tx); // F1: first statement, before any row lock
      const [target] = await tx.select({ id: users.id, fullName: users.fullName, role: users.role, approverId: users.approverId })
        .from(users).where(eq(users.id, userId)).for('update');
      if (!target) throw new UserFacingError('User not found.', 'not_found');
      if (target.role !== 'supervisor' && target.role !== 'admin') throw new UserFacingError(APPROVER_ROLES_ONLY);
      if (approverId !== null) await assertValidApprover(tx, approverId);
      if (target.approverId === approverId) return [];

      const beforeFacts = await loadApprovalFacts(tx);
      const before = await snapshotSubmittedEligibility(tx, beforeFacts);
      await tx.update(users).set({ approverId, updatedAt: new Date() }).where(eq(users.id, userId));
      await logAdminChange(tx, {
        actorId: actor.id, entity: 'user', entityId: userId, action: 'approver_changed',
        oldValue: { approverId: target.approverId }, newValue: { approverId },
      });
      await recomputeSelfApproval(tx, actor.id, `${target.fullName}'s designated approver changed`, { before: beforeFacts });
      return newlyEligible(before, await snapshotSubmittedEligibility(tx));
    });
    await notifyReroutedApprovals(rerouted);
    return { approverId };
  });
}

/**
 * Admin notices (feature-plan-certified-outputs.md C2, CO-D19): `selfApprovalBackOn` — self-approval came back on for
 * this admin (the log row id keys the client-side dismissal); `recommendDesignee` — this admin is the only active admin
 * and has no effective designee ("Auditors prefer an independent reviewer…"). Read-only.
 */
export async function getApprovalNotices(): Promise<{ selfApprovalBackOn: { logId: string } | null; recommendDesignee: boolean }> {
  const actor = await requireAdmin();
  const db = await getDb();
  return approvalNotices(db, actor.id, await loadApprovalFacts(db));
}
