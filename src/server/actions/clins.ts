'use server';

import { db } from '@/db';
import { clins } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { requireAdmin } from '@/lib/session';
import { validateClinNumber, validateOptionalString, validateMonetaryValue } from '@/lib/validation';

export async function getClinsByContract(contractId: string) {
  return db.select().from(clins).where(eq(clins.contractId, contractId)).orderBy(clins.clinNumber);
}

export async function createClin(data: {
  contractId: string;
  clinNumber: string;
  description?: string;
  fundedAmount?: string;
}) {
  await requireAdmin();
  const validatedData = {
    contractId: data.contractId,
    clinNumber: validateClinNumber(data.clinNumber),
    description: validateOptionalString(data.description, 'Description', 2000),
    fundedAmount: validateMonetaryValue(data.fundedAmount, 'Funded amount'),
  };
  const rows = await db.insert(clins).values(validatedData).returning();
  return rows[0];
}

export async function updateClin(id: string, data: {
  clinNumber?: string;
  description?: string;
  fundedAmount?: string;
  status?: 'active' | 'inactive' | 'closed';
}) {
  await requireAdmin();
  const validatedData: Record<string, unknown> = { updatedAt: new Date() };
  if (data.clinNumber !== undefined) validatedData.clinNumber = validateClinNumber(data.clinNumber);
  if (data.description !== undefined) validatedData.description = validateOptionalString(data.description, 'Description', 2000);
  if (data.fundedAmount !== undefined) validatedData.fundedAmount = validateMonetaryValue(data.fundedAmount, 'Funded amount');
  if (data.status !== undefined) validatedData.status = data.status;
  const rows = await db.update(clins)
    .set(validatedData)
    .where(eq(clins.id, id))
    .returning();
  return rows[0];
}
