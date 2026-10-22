'use server';

import { getDb, getDbForWrite } from '@/db';
import { users } from '@/db/schema';
import bcrypt from 'bcryptjs';
import { eq, and, ne, sql } from 'drizzle-orm';
import { requireAdmin, requireAdminFresh } from '@/lib/session';
import { unlockAccount } from '@/server/internal/login-attempts';
import { SAFE_USER_COLUMNS } from '@/server/internal/users';
import { assertSeatsAvailable } from '@/server/internal/seats';
import { validateEmail, validateRequired, validateStringLength, validateEnum } from '@/lib/validation';

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
  const db = await getDbForWrite();
  await requireAdminFresh();
  await assertSeatAvailable();
  const validatedData = {
    email: validateEmail(data.email),
    fullName: validateStringLength(validateRequired(data.fullName, 'Full name'), 'Full name', 1, 255),
    role: data.role ? validateEnum(data.role, 'Role', USER_ROLES) : 'employee' as const,
  };
  const rows = await db.insert(users).values(validatedData).returning(SAFE_USER_COLUMNS);
  return rows[0];
}

export async function unlockUserAccount(email: string): Promise<void> {
  await requireAdminFresh();
  await unlockAccount(email);
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
  const actor = await requireAdminFresh();
  const db = await getDbForWrite();

  // Server-action arguments are untrusted JSON. The last-admin and self-deactivation checks
  // below key on `isActive === false`, and Postgres would happily coerce "false" or 0 to false,
  // so anything that isn't a real boolean is rejected up front.
  if (data.isActive !== undefined && typeof data.isActive !== 'boolean') {
    throw new Error('Active status must be true or false.');
  }
  if (data.flsaExempt !== undefined && typeof data.flsaExempt !== 'boolean') {
    throw new Error('FLSA exempt must be true or false.');
  }

  // An admin cannot change their own role or deactivate themselves.
  if (actor.id === id) {
    if (data.role !== undefined && data.role !== actor.role) {
      throw new Error('Forbidden: You cannot change your own role.');
    }
    if (data.isActive === false) {
      throw new Error('Forbidden: You cannot deactivate your own account.');
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
      const [target] = await tx
        .select({ role: users.role, isActive: users.isActive })
        .from(users)
        .where(eq(users.id, id))
        .for('update');

      if (target?.role === 'admin' && target.isActive) {
        // Lock the OTHER active admin rows too, so a concurrent transaction demoting one of
        // THEM has to wait for this one to finish before it can (correctly) see the new count.
        const otherActiveAdmins = await tx
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.role, 'admin'), eq(users.isActive, true), ne(users.id, id)))
          .for('update');
        if (otherActiveAdmins.length === 0) {
          throw new Error(
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
}

export async function createUserWithPassword(data: {
  email: string;
  fullName: string;
  role: 'admin' | 'supervisor' | 'employee';
  password: string;
}) {
  const db = await getDbForWrite();
  await requireAdminFresh();
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
}
