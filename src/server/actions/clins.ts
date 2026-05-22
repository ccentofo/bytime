'use server';

import { db } from '@/db';
import { clins } from '@/db/schema';
import { eq } from 'drizzle-orm';

export async function getClinsByContract(contractId: string) {
  return db.select().from(clins).where(eq(clins.contractId, contractId)).orderBy(clins.clinNumber);
}

export async function createClin(data: {
  contractId: string;
  clinNumber: string;
  description?: string;
}) {
  const rows = await db.insert(clins).values(data).returning();
  return rows[0];
}

export async function updateClin(id: string, data: {
  clinNumber?: string;
  description?: string;
  status?: 'active' | 'inactive' | 'closed';
}) {
  const rows = await db.update(clins)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(clins.id, id))
    .returning();
  return rows[0];
}
