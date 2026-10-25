'use server';

import { getDb, getDbForWrite } from '@/db';
import { contracts } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { requireAdmin, requireAdminFresh } from '@/lib/session';
import { validateContractNumber, validateRequired, validateStringLength, validateOptionalString, validateOptionalCalendarDate, validateMonetaryValue } from '@/lib/validation';
import type { CalendarDate } from '@/lib/calendar-date';
import { userAction } from '@/lib/action-result';

export type Contract = Omit<typeof contracts.$inferSelect, 'startDate' | 'endDate'> & {
  startDate: CalendarDate | null;
  endDate: CalendarDate | null;
};

export async function getContracts(): Promise<Contract[]> {
  await requireAdmin();
  const db = await getDb();
  const rows = await db.select().from(contracts).orderBy(contracts.name);
  return rows as Contract[];
}

export async function getContractById(id: string): Promise<Contract | null> {
  await requireAdmin();
  const db = await getDb();
  const rows = await db.select().from(contracts).where(eq(contracts.id, id));
  return (rows[0] as Contract) ?? null;
}

export async function createContract(data: {
  contractNumber: string;
  name: string;
  description?: string;
  contractType?: string;
  startDate?: CalendarDate;
  endDate?: CalendarDate;
  fundedValue?: string;
  ceilingValue?: string;
}) {
  return userAction(async () => {
    await requireAdminFresh();
    const db = await getDbForWrite();
    const validatedData = {
      contractNumber: validateContractNumber(data.contractNumber),
      name: validateStringLength(validateRequired(data.name, 'Contract name'), 'Contract name', 1, 255),
      description: validateOptionalString(data.description, 'Description', 2000),
      contractType: data.contractType ?? 'prime',
      startDate: validateOptionalCalendarDate(data.startDate, 'Start date'),
      endDate: validateOptionalCalendarDate(data.endDate, 'End date'),
      fundedValue: validateMonetaryValue(data.fundedValue, 'Funded value'),
      ceilingValue: validateMonetaryValue(data.ceilingValue, 'Ceiling value'),
    };
    const rows = await db.insert(contracts).values(validatedData).returning();
    return rows[0];
  });
}

export async function updateContract(id: string, data: {
  contractNumber?: string;
  name?: string;
  description?: string;
  contractType?: string;
  status?: 'active' | 'inactive' | 'closed';
  startDate?: CalendarDate;
  endDate?: CalendarDate;
  fundedValue?: string;
  ceilingValue?: string;
}) {
  return userAction(async () => {
    await requireAdminFresh();
    const db = await getDbForWrite();
    const validatedData: Record<string, unknown> = { updatedAt: new Date() };
    if (data.contractNumber !== undefined) validatedData.contractNumber = validateContractNumber(data.contractNumber);
    if (data.name !== undefined) validatedData.name = validateStringLength(validateRequired(data.name, 'Contract name'), 'Contract name', 1, 255);
    if (data.description !== undefined) validatedData.description = validateOptionalString(data.description, 'Description', 2000);
    if (data.contractType !== undefined) validatedData.contractType = data.contractType;
    if (data.status !== undefined) validatedData.status = data.status;
    if (data.startDate !== undefined) validatedData.startDate = validateOptionalCalendarDate(data.startDate, 'Start date');
    if (data.endDate !== undefined) validatedData.endDate = validateOptionalCalendarDate(data.endDate, 'End date');
    if (data.fundedValue !== undefined) validatedData.fundedValue = validateMonetaryValue(data.fundedValue, 'Funded value');
    if (data.ceilingValue !== undefined) validatedData.ceilingValue = validateMonetaryValue(data.ceilingValue, 'Ceiling value');
    const rows = await db.update(contracts)
      .set(validatedData)
      .where(eq(contracts.id, id))
      .returning();
    return rows[0];
  });
}
