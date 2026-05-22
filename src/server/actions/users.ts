'use server';

import { db } from '@/db';
import { users } from '@/db/schema';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';

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
  const rows = await db.insert(users).values(data).returning();
  return rows[0];
}

export async function seedUsers() {
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
}) {
  const rows = await db.update(users)
    .set({ ...data, updatedAt: new Date() })
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
  const hash = await bcrypt.hash(data.password, 12);
  const rows = await db.insert(users).values({
    email: data.email,
    fullName: data.fullName,
    role: data.role,
    passwordHash: hash,
  }).returning();
  return rows[0];
}
