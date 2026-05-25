'use server';

import { db } from '@/db';
import { slins } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { requireAdmin } from '@/lib/session';
import { validateSlinNumber, validateOptionalString, validateMonetaryValue } from '@/lib/validation';

export async function getSlinsByClin(clinId: string) {
  return db.select().from(slins).where(eq(slins.clinId, clinId)).orderBy(slins.slinNumber);
}

export async function createSlin(data: {
  clinId: string;
  slinNumber: string;
  description?: string;
  fundedAmount?: string;
}) {
  await requireAdmin();
  const validatedData = {
    clinId: data.clinId,
    slinNumber: validateSlinNumber(data.slinNumber),
    description: validateOptionalString(data.description, 'Description', 2000),
    fundedAmount: validateMonetaryValue(data.fundedAmount, 'Funded amount'),
  };
  const rows = await db.insert(slins).values(validatedData).returning();
  return rows[0];
}

export async function updateSlin(id: string, data: {
  slinNumber?: string;
  description?: string;
  fundedAmount?: string;
  status?: 'active' | 'inactive' | 'closed';
}) {
  await requireAdmin();
  const validatedData: Record<string, unknown> = { updatedAt: new Date() };
  if (data.slinNumber !== undefined) validatedData.slinNumber = validateSlinNumber(data.slinNumber);
  if (data.description !== undefined) validatedData.description = validateOptionalString(data.description, 'Description', 2000);
  if (data.fundedAmount !== undefined) validatedData.fundedAmount = validateMonetaryValue(data.fundedAmount, 'Funded amount');
  if (data.status !== undefined) validatedData.status = data.status;
  const rows = await db.update(slins)
    .set(validatedData)
    .where(eq(slins.id, id))
    .returning();
  return rows[0];
}
