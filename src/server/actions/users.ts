'use server';

import { getDb } from '@/db';
import { users } from '@/db/schema';
import bcrypt from 'bcryptjs';
import { count, eq, and, ne } from 'drizzle-orm';
import { requireAdmin } from '@/lib/session';
import { unlockAccount } from '@/server/internal/login-attempts';
import { validateEmail, validateRequired, validateStringLength, validateEnum } from '@/lib/validation';
import { getTenantOrThrow } from '@/lib/tenant/context';
import { PLANS, type PlanKey } from '@/lib/billing/plans';

async function assertSeatAvailable(): Promise<void> {
  const db = await getDb();
  const tenant = await getTenantOrThrow();
  const limit = PLANS[(tenant.plan as PlanKey)]?.seatLimit ?? PLANS.trial.seatLimit;
  if (limit == null) return; // unlimited (enterprise)
  const [result] = await db
    .select({ value: count() })
    .from(users)
    .where(eq(users.isActive, true));
  if (Number(result.value) >= limit) {
    throw new Error(
      `Your ${PLANS[tenant.plan as PlanKey]?.label ?? 'current'} plan allows ${limit} active users. Upgrade in Billing to add more.`
    );
  }
}

const USER_ROLES = ['admin', 'supervisor', 'employee'] as const;

/** List every user. Admin only — includes roles and active state, used to drive user management. */
export async function getUsers() {
  await requireAdmin();
  const db = await getDb();
  return db.select().from(users).orderBy(users.fullName);
}

export async function createUser(data: {
  email: string;
  fullName: string;
  role?: 'admin' | 'supervisor' | 'employee';
}) {
  const db = await getDb();
  await requireAdmin();
  await assertSeatAvailable();
  const validatedData = {
    email: validateEmail(data.email),
    fullName: validateStringLength(validateRequired(data.fullName, 'Full name'), 'Full name', 1, 255),
    role: data.role ? validateEnum(data.role, 'Role', USER_ROLES) : 'employee' as const,
  };
  const rows = await db.insert(users).values(validatedData).returning();
  return rows[0];
}

export async function unlockUserAccount(email: string): Promise<void> {
  await requireAdmin();
  await unlockAccount(email);
}

/**
 * Seed demo users with a known default password. Development/demo convenience only —
 * refuses outright in production so a known-password account can never be created there (F12).
 */
export async function seedUsers() {
  await requireAdmin();
  if (process.env.NODE_ENV === 'production') {
    throw new Error('seedUsers is disabled in production.');
  }
  const db = await getDb();
  // Hash the default dev password for all seed users
  const defaultPassword = 'Password123!';
  const hash = await bcrypt.hash(defaultPassword, 12);

  const seedData = [
    { email: 'admin@cadenzpoint.dev', fullName: 'Admin User', role: 'admin' as const, passwordHash: hash },
    { email: 'jane.smith@cadenzpoint.dev', fullName: 'Jane Smith', role: 'employee' as const, passwordHash: hash },
    { email: 'john.doe@cadenzpoint.dev', fullName: 'John Doe', role: 'employee' as const, passwordHash: hash },
    { email: 'sarah.wilson@cadenzpoint.dev', fullName: 'Sarah Wilson', role: 'supervisor' as const, passwordHash: hash },
  ];

  // Upsert: update password_hash for existing users, insert new ones
  const results = [];
  for (const user of seedData) {
    const existing = await db.select().from(users).where(eq(users.email, user.email));
    if (existing.length > 0) {
      const updated = await db.update(users)
        .set({ passwordHash: user.passwordHash })
        .where(eq(users.email, user.email))
        .returning();
      results.push(updated[0]);
    } else {
      const inserted = await db.insert(users).values(user).returning();
      results.push(inserted[0]);
    }
  }

  return results;
}

export async function updateUser(id: string, data: {
  fullName?: string;
  email?: string;
  role?: 'admin' | 'supervisor' | 'employee';
  isActive?: boolean;
  flsaExempt?: boolean;
}) {
  const actor = await requireAdmin();
  const db = await getDb();

  // An admin cannot change their own role or deactivate themselves.
  if (actor.id === id) {
    if (data.role !== undefined && data.role !== actor.role) {
      throw new Error('Forbidden: You cannot change your own role.');
    }
    if (data.isActive === false) {
      throw new Error('Forbidden: You cannot deactivate your own account.');
    }
  }

  // Nobody can demote or deactivate the last active admin.
  const demotingRole = data.role !== undefined && data.role !== 'admin';
  const deactivating = data.isActive === false;
  if (demotingRole || deactivating) {
    const [target] = await db.select({ role: users.role, isActive: users.isActive }).from(users).where(eq(users.id, id));
    if (target?.role === 'admin' && target.isActive) {
      const [{ value: activeAdminCount }] = await db
        .select({ value: count() })
        .from(users)
        .where(and(eq(users.role, 'admin'), eq(users.isActive, true), ne(users.id, id)));
      if (Number(activeAdminCount) === 0) {
        throw new Error(
          demotingRole
            ? 'Forbidden: Cannot change the role of the last active admin.'
            : 'Forbidden: Cannot deactivate the last active admin.'
        );
      }
    }
  }

  // Determine if this change should invalidate existing sessions
  const shouldInvalidateSession = data.role !== undefined || data.isActive !== undefined;

  const updateData: Record<string, unknown> = {
    ...data,
    updatedAt: new Date(),
  };

  if (shouldInvalidateSession) {
    // Increment sessionVersion to force re-authentication
    const [currentUser] = await db
      .select({ sessionVersion: users.sessionVersion })
      .from(users)
      .where(eq(users.id, id));

    if (currentUser) {
      updateData.sessionVersion = currentUser.sessionVersion + 1;
    }
  }

  const rows = await db.update(users)
    .set(updateData)
    .where(eq(users.id, id))
    .returning();
  return rows[0];
}

export async function createUserWithPassword(data: {
  email: string;
  fullName: string;
  role: 'admin' | 'supervisor' | 'employee';
  password: string;
}) {
  const db = await getDb();
  await requireAdmin();
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
  }).returning();
  return rows[0];
}
