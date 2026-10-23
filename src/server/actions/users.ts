'use server';

import { getDb, getDbForAuth, getDbForWrite } from '@/db';
import { users } from '@/db/schema';
import bcrypt from 'bcryptjs';
import { eq, and, sql } from 'drizzle-orm';
import { requireAdmin, requireAdminFresh, AuthorizationError } from '@/lib/session';
import { unlockAccount } from '@/server/internal/login-attempts';
import { SAFE_USER_COLUMNS } from '@/server/internal/users';
import { assertSeatsAvailable } from '@/server/internal/seats';
import { validateEmail, validateRequired, validateStringLength, validateEnum } from '@/lib/validation';
import { UserFacingError } from '@/lib/errors';
import { userAction, type ActionResult } from '@/lib/action-result';

async function assertSeatAvailable(): Promise<void> {
  await assertSeatsAvailable(1);
}

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
    await requireAdminFresh();
    const db = await getDbForWrite();
    await assertSeatAvailable();
    const validatedData = {
      email: validateEmail(data.email),
      fullName: validateStringLength(validateRequired(data.fullName, 'Full name'), 'Full name', 1, 255),
      role: data.role ? validateEnum(data.role, 'Role', USER_ROLES) : 'employee' as const,
    };
    const rows = await db.insert(users).values(validatedData).returning(SAFE_USER_COLUMNS);
    return rows[0];
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

      const rows = await tx.update(users).set(updateData).where(eq(users.id, id)).returning(SAFE_USER_COLUMNS);
      return rows[0];
    });

    return result;
  });
}

export async function createUserWithPassword(data: {
  email: string;
  fullName: string;
  role: 'admin' | 'supervisor' | 'employee';
  password: string;
}) {
  return userAction(async () => {
    await requireAdminFresh();
    const db = await getDbForWrite();
    await assertSeatAvailable();
    const validatedEmail = validateEmail(data.email);
    const validatedName = validateStringLength(validateRequired(data.fullName, 'Full name'), 'Full name', 1, 255);
    const validatedRole = validateEnum(data.role, 'Role', USER_ROLES);
    const hash = await bcrypt.hash(data.password, 12);
    const rows = await db.insert(users).values({
      email: validatedEmail,
      fullName: validatedName,
      role: validatedRole,
      passwordHash: hash,
    }).returning(SAFE_USER_COLUMNS);
    return rows[0];
  });
}
