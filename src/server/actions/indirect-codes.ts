'use server';

import { getDb, getDbForWrite } from '@/db';
import { indirectChargeCodes } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { requireAdmin, requireAdminFresh } from '@/lib/session';
import { validateRequired, validateStringLength, validateOptionalString, validateEnum } from '@/lib/validation';
import { userAction } from '@/lib/action-result';
import { UserFacingError } from '@/lib/errors';

const INDIRECT_CATEGORIES = ['overhead', 'ga', 'irad', 'bp', 'leave', 'unallowable'] as const;
/** certified-outputs C7 (CO-D11): how a leave code's hours are paid — its own payroll column; unpaid never paid. */
const LEAVE_PAY_TYPES = ['pto', 'sick', 'holiday', 'unpaid'] as const;
type LeavePayType = (typeof LEAVE_PAY_TYPES)[number];
const PAY_TYPE_REQUIRED = 'Choose a pay type (PTO, sick, holiday or unpaid) for a leave code — payroll export needs it.';

/** A leave code must have a pay type; any other category has none. */
function resolveLeavePayType(category: string, payType: unknown): LeavePayType | null {
  if (category !== 'leave') return null;
  if (payType === null || payType === undefined || payType === '') throw new UserFacingError(PAY_TYPE_REQUIRED);
  return validateEnum(payType, 'Pay type', LEAVE_PAY_TYPES);
}

/**
 * Get all indirect charge codes.
 */
export async function getIndirectChargeCodes() {
  await requireAdmin();
  const db = await getDb();
  return db.select().from(indirectChargeCodes).orderBy(indirectChargeCodes.category, indirectChargeCodes.code);
}

/**
 * Get active indirect charge codes available to all employees.
 */
export async function getActiveIndirectCodes() {
  await requireAdmin();
  const db = await getDb();
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
  leavePayType?: LeavePayType | null;
}) {
  return userAction(async () => {
    await requireAdminFresh();
    const db = await getDbForWrite();
    const category = validateEnum(data.category, 'Category', INDIRECT_CATEGORIES);
    const validatedData = {
      code: validateStringLength(validateRequired(data.code, 'Code'), 'Code', 1, 50),
      name: validateStringLength(validateRequired(data.name, 'Name'), 'Name', 1, 255),
      category,
      description: validateOptionalString(data.description, 'Description', 2000),
      availableToAll: data.availableToAll,
      leavePayType: resolveLeavePayType(category, data.leavePayType),
    };
    const rows = await db.insert(indirectChargeCodes).values(validatedData).returning();
    return rows[0];
  });
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
  leavePayType?: LeavePayType | null;
}) {
  return userAction(async () => {
    await requireAdminFresh();
    const db = await getDbForWrite();
    const validatedData: Record<string, unknown> = { updatedAt: new Date() };
    if (data.category !== undefined || data.leavePayType !== undefined) {
      // The pay type follows the (possibly new) category: required for leave, cleared otherwise.
      const [current] = await db.select({ category: indirectChargeCodes.category, leavePayType: indirectChargeCodes.leavePayType })
        .from(indirectChargeCodes).where(eq(indirectChargeCodes.id, id));
      if (!current) throw new UserFacingError('Indirect code not found.', 'not_found');
      const category = data.category !== undefined ? validateEnum(data.category, 'Category', INDIRECT_CATEGORIES) : current.category;
      validatedData.leavePayType = resolveLeavePayType(category, data.leavePayType !== undefined ? data.leavePayType : current.leavePayType);
    }
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
  });
}

/**
 * Seed default indirect charge codes (admin only).
 * Creates standard codes if they don't exist.
 */
export async function seedIndirectCodes() {
  return userAction(async () => {
    await requireAdminFresh();
    const db = await getDbForWrite();

    const defaults = [
      { code: 'OH-001', name: 'Overhead', category: 'overhead' as const, description: 'General overhead — admin, training, company meetings' },
      { code: 'GA-001', name: 'General & Administrative', category: 'ga' as const, description: 'G&A expenses — management, accounting, HR' },
      { code: 'IRAD-001', name: 'IR&D', category: 'irad' as const, description: 'Independent Research & Development' },
      { code: 'BP-001', name: 'Bid & Proposal', category: 'bp' as const, description: 'Proposal preparation and bid activities' },
      // CO-D16: built-in leave codes ship with their pay type pre-set.
      { code: 'LV-AL', name: 'Annual Leave', category: 'leave' as const, description: 'Paid annual leave / vacation', leavePayType: 'pto' as const },
      { code: 'LV-SL', name: 'Sick Leave', category: 'leave' as const, description: 'Paid sick leave', leavePayType: 'sick' as const },
      { code: 'LV-HOL', name: 'Holiday', category: 'leave' as const, description: 'Company-observed holiday', leavePayType: 'holiday' as const },
      { code: 'LV-LWOP', name: 'Leave Without Pay', category: 'leave' as const, description: 'Unpaid leave of absence', leavePayType: 'unpaid' as const },
      { code: 'UA-001', name: 'Unallowable', category: 'unallowable' as const, description: 'Non-reimbursable activities (FAR 31.205)' },
    ];

    const existing = await db.select().from(indirectChargeCodes);
    if (existing.length > 0) return existing;

    return db.insert(indirectChargeCodes).values(defaults).returning();
  });
}
