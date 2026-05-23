'use server';

import { db } from '@/db';
import { laborCategories, userLaborCategories, users, clins, contracts, slins } from '@/db/schema';
import { eq, and } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Labor Category CRUD
// ---------------------------------------------------------------------------

/**
 * Get all labor categories for a specific CLIN.
 */
export async function getLaborCategoriesByClin(clinId: string) {
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
  const rows = await db.insert(laborCategories).values(data).returning();
  return rows[0];
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
  const rows = await db.update(laborCategories)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(laborCategories.id, id))
    .returning();
  return rows[0];
}

// ---------------------------------------------------------------------------
// User Labor Category Assignments
// ---------------------------------------------------------------------------

/**
 * Get all user-LCAT assignments with user and LCAT context.
 */
export async function getUserLaborCategoryAssignments() {
  return db
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
}

/**
 * Assign a user to a labor category with an effective date.
 */
export async function assignUserToLaborCategory(data: {
  userId: string;
  laborCategoryId: string;
  effectiveDate: Date;
  endDate?: Date;
  assignedBy?: string;
}) {
  const rows = await db.insert(userLaborCategories).values(data).returning();
  return rows[0];
}

/**
 * End a user's labor category assignment by setting the end_date.
 */
export async function endUserLaborCategoryAssignment(id: string, endDate: Date) {
  const rows = await db.update(userLaborCategories)
    .set({ endDate, updatedAt: new Date() })
    .where(eq(userLaborCategories.id, id))
    .returning();
  return rows[0];
}

/**
 * Get labor categories available for assignment (active LCATs from active CLINs on active contracts).
 * Returns a flat list with contract/CLIN/SLIN context for dropdown population.
 */
export async function getAssignableLaborCategories() {
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
