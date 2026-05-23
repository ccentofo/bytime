'use server';

import { db } from '@/db';
import { contracts } from '@/db/schema';
import { eq } from 'drizzle-orm';

export async function getContracts() {
  return db.select().from(contracts).orderBy(contracts.name);
}

export async function getContractById(id: string) {
  const rows = await db.select().from(contracts).where(eq(contracts.id, id));
  return rows[0] ?? null;
}

export async function createContract(data: {
  contractNumber: string;
  name: string;
  description?: string;
  contractType?: string;
  startDate?: Date;
  endDate?: Date;
  fundedValue?: string;
  ceilingValue?: string;
}) {
  const rows = await db.insert(contracts).values(data).returning();
  return rows[0];
}

export async function updateContract(id: string, data: {
  contractNumber?: string;
  name?: string;
  description?: string;
  contractType?: string;
  status?: 'active' | 'inactive' | 'closed';
  startDate?: Date;
  endDate?: Date;
  fundedValue?: string;
  ceilingValue?: string;
}) {
  const rows = await db.update(contracts)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(contracts.id, id))
    .returning();
  return rows[0];
}
