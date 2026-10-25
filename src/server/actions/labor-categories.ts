'use server';

import { getDb, getDbForWrite } from '@/db';
import { laborCategories, userLaborCategories, users, clins, contracts, slins } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { requireAdmin, requireAdminFresh } from '@/lib/session';
import { validateRequired, validateStringLength, validateOptionalString, validateRate } from '@/lib/validation';
import { parseCalendarDate, type CalendarDate } from '@/lib/calendar-date';
import { getWorkspaceToday } from '@/server/internal/workspace-settings';
import { userAction } from '@/lib/action-result';

// ---------------------------------------------------------------------------
// Labor Category CRUD
// ---------------------------------------------------------------------------

/**
 * Get all labor categories for a specific CLIN.
 */
export async function getLaborCategoriesByClin(clinId: string) {
  await requireAdmin();
  const db = await getDb();
  return db
    .select()
    .from(laborCategories)
    .where(eq(laborCategories.clinId, clinId))
    .orderBy(laborCategories.lcatCode);
}

/**
 * Get all labor categories across all CLINs, with contract/CLIN/SLIN context.
 * Used for the main Labor Categories admin page.
 */
export async function getAllLaborCategories() {
  await requireAdmin();
  const db = await getDb();
  return db
    .select({
      id: laborCategories.id,
      clinId: laborCategories.clinId,
      slinId: laborCategories.slinId,
      lcatCode: laborCategories.lcatCode,
      title: laborCategories.title,
      hourlyRate: laborCategories.hourlyRate,
      ceilingRate: laborCategories.ceilingRate,
      status: laborCategories.status,
      createdAt: laborCategories.createdAt,
      updatedAt: laborCategories.updatedAt,
      clinNumber: clins.clinNumber,
      clinDescription: clins.description,
      contractName: contracts.name,
      contractNumber: contracts.contractNumber,
      slinNumber: slins.slinNumber,
    })
    .from(laborCategories)
    .innerJoin(clins, eq(laborCategories.clinId, clins.id))
    .innerJoin(contracts, eq(clins.contractId, contracts.id))
    .leftJoin(slins, eq(laborCategories.slinId, slins.id))
    .orderBy(contracts.name, clins.clinNumber, laborCategories.lcatCode);
}

/**
 * Create a new labor category under a CLIN (optionally under a SLIN).
 */
export async function createLaborCategory(data: {
  clinId: string;
  slinId?: string;
  lcatCode: string;
  title: string;
  hourlyRate: string;
  ceilingRate?: string;
}) {
  return userAction(async () => {
    await requireAdminFresh();
    const db = await getDbForWrite();
    const validatedData = {
      clinId: data.clinId,
      slinId: data.slinId,
      lcatCode: validateStringLength(validateRequired(data.lcatCode, 'LCAT code'), 'LCAT code', 1, 50),
      title: validateStringLength(validateRequired(data.title, 'Title'), 'Title', 1, 255),
      hourlyRate: validateRate(data.hourlyRate, 'Hourly rate'),
      ceilingRate: data.ceilingRate ? validateRate(data.ceilingRate, 'Ceiling rate') : undefined,
    };
    const rows = await db.insert(laborCategories).values(validatedData).returning();
    return rows[0];
  });
}

/**
 * Update an existing labor category.
 */
export async function updateLaborCategory(id: string, data: {
  lcatCode?: string;
  title?: string;
  hourlyRate?: string;
  ceilingRate?: string;
  status?: 'active' | 'inactive' | 'closed';
}) {
  return userAction(async () => {
    await requireAdminFresh();
    const db = await getDbForWrite();
    const validatedData: Record<string, unknown> = { updatedAt: new Date() };
    if (data.lcatCode !== undefined) validatedData.lcatCode = validateStringLength(validateRequired(data.lcatCode, 'LCAT code'), 'LCAT code', 1, 50);
    if (data.title !== undefined) validatedData.title = validateStringLength(validateRequired(data.title, 'Title'), 'Title', 1, 255);
    if (data.hourlyRate !== undefined) validatedData.hourlyRate = validateRate(data.hourlyRate, 'Hourly rate');
    if (data.ceilingRate !== undefined) validatedData.ceilingRate = data.ceilingRate ? validateRate(data.ceilingRate, 'Ceiling rate') : undefined;
    if (data.status !== undefined) validatedData.status = data.status;
    const rows = await db.update(laborCategories)
      .set(validatedData)
      .where(eq(laborCategories.id, id))
      .returning();
    return rows[0];
  });
}

// ---------------------------------------------------------------------------
// User Labor Category Assignments
// ---------------------------------------------------------------------------

/**
 * Get all user-LCAT assignments with user and LCAT context.
 */
export interface UserLcatAssignment {
  id: string;
  userId: string;
  laborCategoryId: string;
  effectiveDate: CalendarDate;
  endDate: CalendarDate | null;
  createdAt: Date;
  userName: string;
  userEmail: string;
  lcatCode: string;
  lcatTitle: string;
  hourlyRate: string;
  clinNumber: string;
  contractName: string;
  contractNumber: string;
}

export async function getUserLaborCategoryAssignments(): Promise<UserLcatAssignment[]> {
  await requireAdmin();
  const db = await getDb();
  const rows = await db
    .select({
      id: userLaborCategories.id,
      userId: userLaborCategories.userId,
      laborCategoryId: userLaborCategories.laborCategoryId,
      effectiveDate: userLaborCategories.effectiveDate,
      endDate: userLaborCategories.endDate,
      createdAt: userLaborCategories.createdAt,
      userName: users.fullName,
      userEmail: users.email,
      lcatCode: laborCategories.lcatCode,
      lcatTitle: laborCategories.title,
      hourlyRate: laborCategories.hourlyRate,
      clinNumber: clins.clinNumber,
      contractName: contracts.name,
      contractNumber: contracts.contractNumber,
    })
    .from(userLaborCategories)
    .innerJoin(users, eq(userLaborCategories.userId, users.id))
    .innerJoin(laborCategories, eq(userLaborCategories.laborCategoryId, laborCategories.id))
    .innerJoin(clins, eq(laborCategories.clinId, clins.id))
    .innerJoin(contracts, eq(clins.contractId, contracts.id))
    .orderBy(users.fullName, contracts.name, clins.clinNumber);
  return rows as UserLcatAssignment[];
}

/**
 * Assign a user to a labor category with an effective date.
 */
export async function assignUserToLaborCategory(data: {
  userId: string;
  laborCategoryId: string;
  effectiveDate: CalendarDate;
  endDate?: CalendarDate;
}) {
  return userAction(async () => {
    const actor = await requireAdminFresh();
    const db = await getDbForWrite();
    // R2-6: explicit allowlist — never spread the caller's object into .values().
    const rows = await db.insert(userLaborCategories).values({
      userId: data.userId,
      laborCategoryId: data.laborCategoryId,
      effectiveDate: parseCalendarDate(data.effectiveDate),
      endDate: data.endDate ? parseCalendarDate(data.endDate) : undefined,
      assignedBy: actor.id,
    }).returning();
    return rows[0];
  });
}

/**
 * End a user's labor category assignment: end_date (the INCLUSIVE last day) becomes the
 * workspace's today, so hours already entered today still count toward this labor category.
 */
export async function endUserLaborCategoryAssignment(id: string) {
  return userAction(async () => {
    await requireAdminFresh();
    const db = await getDbForWrite();
    const endDate = await getWorkspaceToday();
    const rows = await db.update(userLaborCategories)
      .set({ endDate, updatedAt: new Date() })
      .where(eq(userLaborCategories.id, id))
      .returning();
    return rows[0];
  });
}

/**
 * Get labor categories available for assignment (active LCATs from active CLINs on active contracts).
 * Returns a flat list with contract/CLIN/SLIN context for dropdown population.
 */
export async function getAssignableLaborCategories() {
  await requireAdmin();
  const db = await getDb();
  return db
    .select({
      id: laborCategories.id,
      lcatCode: laborCategories.lcatCode,
      title: laborCategories.title,
      hourlyRate: laborCategories.hourlyRate,
      clinId: laborCategories.clinId,
      slinId: laborCategories.slinId,
      clinNumber: clins.clinNumber,
      contractName: contracts.name,
      contractNumber: contracts.contractNumber,
      slinNumber: slins.slinNumber,
    })
    .from(laborCategories)
    .innerJoin(clins, eq(laborCategories.clinId, clins.id))
    .innerJoin(contracts, eq(clins.contractId, contracts.id))
    .leftJoin(slins, eq(laborCategories.slinId, slins.id))
    .where(
      and(
        eq(laborCategories.status, 'active'),
        eq(clins.status, 'active'),
        eq(contracts.status, 'active'),
      )
    )
    .orderBy(contracts.name, clins.clinNumber, laborCategories.lcatCode);
}
