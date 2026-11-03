'use server';

import { getDb, getDbForWrite } from '@/db';
import { clins, contracts } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { requireAdmin, requireAdminFresh } from '@/lib/session';
import { validateClinNumber, validateOptionalString, validateMonetaryValue, validateUUID } from '@/lib/validation';
import { userAction } from '@/lib/action-result';
import { UserFacingError } from '@/lib/errors';

export async function getClinsByContract(contractId: string) {
  await requireAdmin();
  const db = await getDb();
  return db.select().from(clins).where(eq(clins.contractId, contractId)).orderBy(clins.clinNumber);
}

export async function createClin(data: {
  contractId: string;
  clinNumber: string;
  description?: string;
  fundedAmount?: string;
}) {
  return userAction(async () => {
    await requireAdminFresh();
    // feature-plan-ux-kit-contracts.md §4.1.10: a real, active parent (C3: a closed contract takes no new CLINs).
    const contractId = validateUUID(data.contractId, 'Contract');
    const db = await getDbForWrite();
    const [parent] = await db.select({ status: contracts.status }).from(contracts).where(eq(contracts.id, contractId));
    if (!parent) throw new UserFacingError('That contract no longer exists.', 'not_found');
    if (parent.status !== 'active') throw new UserFacingError("This contract isn't active. Reopen it before adding CLINs.");
    const validatedData = {
      contractId,
      clinNumber: validateClinNumber(data.clinNumber),
      description: validateOptionalString(data.description, 'Description', 2000),
      fundedAmount: validateMonetaryValue(data.fundedAmount, 'Funded amount'),
    };
    const rows = await db.insert(clins).values(validatedData).returning();
    return rows[0];
  });
}

export async function updateClin(id: string, data: {
  clinNumber?: string;
  description?: string;
  fundedAmount?: string;
  status?: 'active' | 'inactive' | 'closed';
}) {
  return userAction(async () => {
    await requireAdminFresh();
    validateUUID(id, 'CLIN');
    const db = await getDbForWrite();
    const validatedData: Record<string, unknown> = { updatedAt: new Date() };
    if (data.clinNumber !== undefined) validatedData.clinNumber = validateClinNumber(data.clinNumber);
    if (data.description !== undefined) validatedData.description = validateOptionalString(data.description, 'Description', 2000);
    if (data.fundedAmount !== undefined) validatedData.fundedAmount = validateMonetaryValue(data.fundedAmount, 'Funded amount');
    if (data.status !== undefined) validatedData.status = data.status;
    const rows = await db.update(clins)
      .set(validatedData)
      .where(eq(clins.id, id))
      .returning();
    if (!rows[0]) throw new UserFacingError('That CLIN no longer exists.', 'not_found');
    return rows[0];
  });
}
