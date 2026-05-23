'use server';

import { db } from '@/db';
import { slins } from '@/db/schema';
import { eq } from 'drizzle-orm';

export async function getSlinsByClin(clinId: string) {
  return db.select().from(slins).where(eq(slins.clinId, clinId)).orderBy(slins.slinNumber);
}

export async function createSlin(data: {
  clinId: string;
  slinNumber: string;
  description?: string;
  fundedAmount?: string;
}) {
  const rows = await db.insert(slins).values(data).returning();
  return rows[0];
}

export async function updateSlin(id: string, data: {
  slinNumber?: string;
  description?: string;
  fundedAmount?: string;
  status?: 'active' | 'inactive' | 'closed';
}) {
  const rows = await db.update(slins)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(slins.id, id))
    .returning();
  return rows[0];
}
