'use server';

import { db } from '@/db';
import { contracts, clins, laborCategories, users, userAssignments, indirectChargeCodes } from '@/db/schema';
import { ne, count } from 'drizzle-orm';
import { requireAdmin } from '@/lib/session';

export interface SetupStatus {
  indirectCodes: number;
  contracts: number;
  clins: number;
  laborCategories: number;
  employees: number;    // non-admin users
  assignments: number;
  isComplete: boolean;  // all required steps done
}

/**
 * Get the current setup status by counting core entities.
 * Used by the Setup Wizard and the app shell banner.
 * All queries run in parallel for performance.
 */
export async function getSetupStatus(): Promise<SetupStatus> {
  await requireAdmin();

  const [
    indirectResult,
    contractResult,
    clinResult,
    lcatResult,
    employeeResult,
    assignmentResult,
  ] = await Promise.all([
    db.select({ count: count() }).from(indirectChargeCodes),
    db.select({ count: count() }).from(contracts),
    db.select({ count: count() }).from(clins),
    db.select({ count: count() }).from(laborCategories),
    db.select({ count: count() }).from(users).where(ne(users.role, 'admin')),
    db.select({ count: count() }).from(userAssignments),
  ]);

  const status = {
    indirectCodes: indirectResult[0]?.count ?? 0,
    contracts: contractResult[0]?.count ?? 0,
    clins: clinResult[0]?.count ?? 0,
    laborCategories: lcatResult[0]?.count ?? 0,
    employees: employeeResult[0]?.count ?? 0,
    assignments: assignmentResult[0]?.count ?? 0,
  };

  return {
    ...status,
    isComplete:
      status.contracts > 0 &&
      status.clins > 0 &&
      status.employees > 0 &&
      status.assignments > 0,
  };
}

/**
 * Internal variant of getSetupStatus that skips auth.
 * ONLY call this from server components that have already verified the session.
 * Used by the app layout to avoid a redundant auth() call.
 */
export async function getSetupStatusInternal(): Promise<SetupStatus> {
  const [
    indirectResult,
    contractResult,
    clinResult,
    lcatResult,
    employeeResult,
    assignmentResult,
  ] = await Promise.all([
    db.select({ count: count() }).from(indirectChargeCodes),
    db.select({ count: count() }).from(contracts),
    db.select({ count: count() }).from(clins),
    db.select({ count: count() }).from(laborCategories),
    db.select({ count: count() }).from(users).where(ne(users.role, 'admin')),
    db.select({ count: count() }).from(userAssignments),
  ]);

  const status = {
    indirectCodes: indirectResult[0]?.count ?? 0,
    contracts: contractResult[0]?.count ?? 0,
    clins: clinResult[0]?.count ?? 0,
    laborCategories: lcatResult[0]?.count ?? 0,
    employees: employeeResult[0]?.count ?? 0,
    assignments: assignmentResult[0]?.count ?? 0,
  };

  return {
    ...status,
    isComplete:
      status.contracts > 0 &&
      status.clins > 0 &&
      status.employees > 0 &&
      status.assignments > 0,
  };
}
