'use server';

import { getDb, getDbForWrite } from '@/db';
import { clins, contracts, slins } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { requireAdmin, requireAdminFresh } from '@/lib/session';
import { validateSlinNumber, validateOptionalString, validateMonetaryValue, validateUUID } from '@/lib/validation';
import { userAction } from '@/lib/action-result';
import { UserFacingError } from '@/lib/errors';

export async function getSlinsByClin(clinId: string) {
  await requireAdmin();
  const db = await getDb();
  return db.select().from(slins).where(eq(slins.clinId, clinId)).orderBy(slins.slinNumber);
}

export async function createSlin(data: {
  clinId: string;
  slinNumber: string;
  description?: string;
  fundedAmount?: string;
}) {
  return userAction(async () => {
    await requireAdminFresh();
    // feature-plan-ux-kit-contracts.md §4.1.10: the CLIN and its contract must both be active.
    const clinId = validateUUID(data.clinId, 'CLIN');
    const db = await getDbForWrite();
    const [parent] = await db.select({ clinStatus: clins.status, contractStatus: contracts.status })
      .from(clins).innerJoin(contracts, eq(clins.contractId, contracts.id)).where(eq(clins.id, clinId));
    if (!parent) throw new UserFacingError('That CLIN no longer exists.', 'not_found');
    if (parent.clinStatus !== 'active' || parent.contractStatus !== 'active') throw new UserFacingError("This CLIN or its contract isn't active.");
    const validatedData = {
      clinId,
      slinNumber: validateSlinNumber(data.slinNumber),
      description: validateOptionalString(data.description, 'Description', 2000),
      fundedAmount: validateMonetaryValue(data.fundedAmount, 'Funded amount'),
    };
    const rows = await db.insert(slins).values(validatedData).returning();
    return rows[0];
  });
}

export async function updateSlin(id: string, data: {
  slinNumber?: string;
  description?: string;
  fundedAmount?: string;
  status?: 'active' | 'inactive' | 'closed';
}) {
  return userAction(async () => {
    await requireAdminFresh();
    validateUUID(id, 'SLIN');
    const db = await getDbForWrite();
    const validatedData: Record<string, unknown> = { updatedAt: new Date() };
    if (data.slinNumber !== undefined) validatedData.slinNumber = validateSlinNumber(data.slinNumber);
    if (data.description !== undefined) validatedData.description = validateOptionalString(data.description, 'Description', 2000);
    if (data.fundedAmount !== undefined) validatedData.fundedAmount = validateMonetaryValue(data.fundedAmount, 'Funded amount');
    if (data.status !== undefined) validatedData.status = data.status;
    const rows = await db.update(slins)
      .set(validatedData)
      .where(eq(slins.id, id))
      .returning();
    if (!rows[0]) throw new UserFacingError('That SLIN no longer exists.', 'not_found');
    return rows[0];
  });
}
