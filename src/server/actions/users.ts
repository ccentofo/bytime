'use server';

import { getDb, getDbForAuth, getDbForWrite } from '@/db';
import { users } from '@/db/schema';
import bcrypt from 'bcryptjs';
import { eq, and, sql } from 'drizzle-orm';
import { requireAdmin, requireAdminFresh, AuthorizationError } from '@/lib/session';
import { unlockAccount } from '@/server/internal/login-attempts';
import { SAFE_USER_COLUMNS } from '@/server/internal/users';
import { assertSeatsAvailable } from '@/server/internal/seats';
import { activeAdminIds, currentSelfApprovalOn, effectiveDesignee, loadApprovalFacts, lockUserRulesExclusive, newlyEligible, recomputeSelfApproval, snapshotSubmittedEligibility } from '@/server/internal/approval-rules';
import { notifyReroutedApprovals } from '@/server/internal/submission-notify';
import { validateEmail, validateRequired, validateStringLength, validateEnum } from '@/lib/validation';
import { UserFacingError } from '@/lib/errors';
import { userAction, type ActionResult } from '@/lib/action-result';
import { logAdminChange } from '@/server/internal/admin-change-log';

const USER_ROLES = ['admin', 'supervisor', 'employee'] as const;

/** List every user. Admin only — includes roles and active state, used to drive user management. */
export async function getUsers() {
  await requireAdmin();
  const db = await getDb();
  return db.select(SAFE_USER_COLUMNS).from(users).orderBy(users.fullName);
}

export async function createUser(data: {
  email: string;
  fullName: string;
  role?: 'admin' | 'supervisor' | 'employee';
}) {
  return userAction(async () => {
    const actor = await requireAdminFresh();
    const db = await getDbForWrite();
    const validatedData = {
      email: validateEmail(data.email),
      fullName: validateStringLength(validateRequired(data.fullName, 'Full name'), 'Full name', 1, 255),
      role: data.role ? validateEnum(data.role, 'Role', USER_ROLES) : 'employee' as const,
    };
    // certified-outputs C2 (CO-D19, ruling Q5): the insert, the self-approval recompute and the re-routing snapshot run
    // in one transaction; the waiting timesheets' newly eligible approvers are emailed after it commits.
    const { user, rerouted } = await db.transaction(async (tx) => {
      await lockUserRulesExclusive(tx); // F1: first statement, before any row lock
      await assertSeatsAvailable(1, tx);
      const beforeFacts = await loadApprovalFacts(tx);
      const before = await snapshotSubmittedEligibility(tx, beforeFacts);
      const [row] = await tx.insert(users).values(validatedData).returning(SAFE_USER_COLUMNS);
      await recomputeSelfApproval(tx, actor.id, `${row.fullName} added (${row.role})`, { before: beforeFacts });
      return { user: row, rerouted: newlyEligible(before, await snapshotSubmittedEligibility(tx)) };
    });
    await notifyReroutedApprovals(rerouted);
    return user;
  });
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
}) {
  return userAction(async () => {
    const actor = await requireAdminFresh();
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

      if (shouldInvalidateSession) {
        // Increment in SQL so two concurrent edits can't both write the same bumped value.
        updateData.sessionVersion = sql`${users.sessionVersion} + 1`;
      }

      // certified-outputs C2 (CO-D19): self-approval switch + re-routing, in this same transaction.
      const beforeFacts = await loadApprovalFacts(tx);
      const before = await snapshotSubmittedEligibility(tx, beforeFacts);
      const rows = await tx.update(users).set(updateData).where(eq(users.id, id)).returning(SAFE_USER_COLUMNS);
      const changed = rows[0];
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

export async function createUserWithPassword(data: {
  email: string;
  fullName: string;
  role: 'admin' | 'supervisor' | 'employee';
  password: string;
}) {
  return userAction(async () => {
    const actor = await requireAdminFresh();
    const db = await getDbForWrite();
    const validatedEmail = validateEmail(data.email);
    const validatedName = validateStringLength(validateRequired(data.fullName, 'Full name'), 'Full name', 1, 255);
    const validatedRole = validateEnum(data.role, 'Role', USER_ROLES);
    const hash = await bcrypt.hash(data.password, 12);
    // certified-outputs C2 (ruling Q5): one transaction with the self-approval recompute and re-routing snapshot.
    const { user, rerouted } = await db.transaction(async (tx) => {
      await lockUserRulesExclusive(tx); // F1: first statement, before any row lock
      await assertSeatsAvailable(1, tx);
      const beforeFacts = await loadApprovalFacts(tx);
      const before = await snapshotSubmittedEligibility(tx, beforeFacts);
      const [row] = await tx.insert(users).values({
        email: validatedEmail,
        fullName: validatedName,
        role: validatedRole,
        passwordHash: hash,
      }).returning(SAFE_USER_COLUMNS);
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
      if (target.role !== 'supervisor' && target.role !== 'admin') {
        throw new UserFacingError('Approvers can be designated for supervisors and admins only. Employees are approved by their CLIN supervisors and admins.');
      }
      if (approverId !== null) {
        const [approver] = await tx.select({ role: users.role, isActive: users.isActive }).from(users).where(eq(users.id, approverId));
        if (!approver || !approver.isActive || (approver.role !== 'admin' && approver.role !== 'supervisor')) {
          throw new UserFacingError('The approver must be an active admin or supervisor.');
        }
      }
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
  const facts = await loadApprovalFacts(db);
  const on = await currentSelfApprovalOn(db, actor.id);
  const admins = activeAdminIds(facts);
  return {
    selfApprovalBackOn: on ? { logId: on.logId } : null,
    recommendDesignee: admins.length === 1 && admins[0] === actor.id && effectiveDesignee(facts, actor.id) === null,
  };
}
