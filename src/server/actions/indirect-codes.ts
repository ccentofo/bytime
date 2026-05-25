'use server';

import { db } from '@/db';
import { indirectChargeCodes } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { requireAdmin } from '@/lib/session';
import { validateRequired, validateStringLength, validateOptionalString, validateEnum } from '@/lib/validation';

const INDIRECT_CATEGORIES = ['overhead', 'ga', 'irad', 'bp', 'leave', 'unallowable'] as const;

/**
 * Get all indirect charge codes.
 */
export async function getIndirectChargeCodes() {
  return db.select().from(indirectChargeCodes).orderBy(indirectChargeCodes.category, indirectChargeCodes.code);
}

/**
 * Get active indirect charge codes available to all employees.
 */
export async function getActiveIndirectCodes() {
  return db
    .select()
    .from(indirectChargeCodes)
    .where(eq(indirectChargeCodes.isActive, true))
    .orderBy(indirectChargeCodes.category, indirectChargeCodes.code);
}

/**
 * Create a new indirect charge code (admin only).
 */
export async function createIndirectCode(data: {
  code: string;
  name: string;
  category: 'overhead' | 'ga' | 'irad' | 'bp' | 'leave' | 'unallowable';
  description?: string;
  availableToAll?: boolean;
}) {
  await requireAdmin();
  const validatedData = {
    code: validateStringLength(validateRequired(data.code, 'Code'), 'Code', 1, 50),
    name: validateStringLength(validateRequired(data.name, 'Name'), 'Name', 1, 255),
    category: validateEnum(data.category, 'Category', INDIRECT_CATEGORIES),
    description: validateOptionalString(data.description, 'Description', 2000),
    availableToAll: data.availableToAll,
  };
  const rows = await db.insert(indirectChargeCodes).values(validatedData).returning();
  return rows[0];
}

/**
 * Update an indirect charge code (admin only).
 */
export async function updateIndirectCode(id: string, data: {
  code?: string;
  name?: string;
  category?: 'overhead' | 'ga' | 'irad' | 'bp' | 'leave' | 'unallowable';
  description?: string;
  isActive?: boolean;
  availableToAll?: boolean;
}) {
  await requireAdmin();
  const validatedData: Record<string, unknown> = { updatedAt: new Date() };
  if (data.code !== undefined) validatedData.code = validateStringLength(validateRequired(data.code, 'Code'), 'Code', 1, 50);
  if (data.name !== undefined) validatedData.name = validateStringLength(validateRequired(data.name, 'Name'), 'Name', 1, 255);
  if (data.category !== undefined) validatedData.category = validateEnum(data.category, 'Category', INDIRECT_CATEGORIES);
  if (data.description !== undefined) validatedData.description = validateOptionalString(data.description, 'Description', 2000);
  if (data.isActive !== undefined) validatedData.isActive = data.isActive;
  if (data.availableToAll !== undefined) validatedData.availableToAll = data.availableToAll;
  const rows = await db.update(indirectChargeCodes)
    .set(validatedData)
    .where(eq(indirectChargeCodes.id, id))
    .returning();
  return rows[0];
}

/**
 * Seed default indirect charge codes (admin only).
 * Creates standard codes if they don't exist.
 */
export async function seedIndirectCodes() {
  await requireAdmin();

  const defaults = [
    { code: 'OH-001', name: 'Overhead', category: 'overhead' as const, description: 'General overhead — admin, training, company meetings' },
    { code: 'GA-001', name: 'General & Administrative', category: 'ga' as const, description: 'G&A expenses — management, accounting, HR' },
    { code: 'IRAD-001', name: 'IR&D', category: 'irad' as const, description: 'Independent Research & Development' },
    { code: 'BP-001', name: 'Bid & Proposal', category: 'bp' as const, description: 'Proposal preparation and bid activities' },
    { code: 'LV-AL', name: 'Annual Leave', category: 'leave' as const, description: 'Paid annual leave / vacation' },
    { code: 'LV-SL', name: 'Sick Leave', category: 'leave' as const, description: 'Paid sick leave' },
    { code: 'LV-HOL', name: 'Holiday', category: 'leave' as const, description: 'Company-observed holiday' },
    { code: 'LV-LWOP', name: 'Leave Without Pay', category: 'leave' as const, description: 'Unpaid leave of absence' },
    { code: 'UA-001', name: 'Unallowable', category: 'unallowable' as const, description: 'Non-reimbursable activities (FAR 31.205)' },
  ];

  const existing = await db.select().from(indirectChargeCodes);
  if (existing.length > 0) return existing;

  return db.insert(indirectChargeCodes).values(defaults).returning();
}
