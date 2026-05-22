'use server';

import { db } from '@/db';
import { users } from '@/db/schema';

export async function getUsers() {
  return db.select().from(users).orderBy(users.fullName);
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
  // Only seed if the table is empty
  const existing = await db.select().from(users);
  if (existing.length > 0) return existing;

  const seedData = [
    { email: 'admin@bytime.dev', fullName: 'Admin User', role: 'admin' as const },
    { email: 'jane.smith@bytime.dev', fullName: 'Jane Smith', role: 'employee' as const },
    { email: 'john.doe@bytime.dev', fullName: 'John Doe', role: 'employee' as const },
    { email: 'sarah.wilson@bytime.dev', fullName: 'Sarah Wilson', role: 'supervisor' as const },
  ];

  return db.insert(users).values(seedData).returning();
}
