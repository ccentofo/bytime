'use server';

import { db } from '@/db';
import { users } from '@/db/schema';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { requireAdmin } from '@/lib/session';
import { validateEmail, validateRequired, validateStringLength, validateEnum } from '@/lib/validation';

const USER_ROLES = ['admin', 'supervisor', 'employee'] as const;

export async function getUsers() {
  return db.select().from(users).orderBy(users.fullName);
}

export async function getUserByEmail(email: string) {
  const rows = await db.select().from(users).where(eq(users.email, email));
  return rows[0] ?? null;
}

export async function createUser(data: {
  email: string;
  fullName: string;
  role?: 'admin' | 'supervisor' | 'employee';
}) {
  await requireAdmin();
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
  const { unlockAccount } = await import('@/server/actions/login-attempts');
  await unlockAccount(email);
}

export async function seedUsers() {
  await requireAdmin();
  // Hash the default dev password for all seed users
  const defaultPassword = 'Password123!';
  const hash = await bcrypt.hash(defaultPassword, 12);

  const seedData = [
    { email: 'admin@bytime.dev', fullName: 'Admin User', role: 'admin' as const, passwordHash: hash },
    { email: 'jane.smith@bytime.dev', fullName: 'Jane Smith', role: 'employee' as const, passwordHash: hash },
    { email: 'john.doe@bytime.dev', fullName: 'John Doe', role: 'employee' as const, passwordHash: hash },
    { email: 'sarah.wilson@bytime.dev', fullName: 'Sarah Wilson', role: 'supervisor' as const, passwordHash: hash },
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
  await requireAdmin();
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
  await requireAdmin();
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
