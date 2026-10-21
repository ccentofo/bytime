import 'server-only';
import { getDb } from '@/db';
import { contracts, clins, laborCategories, users, userAssignments, indirectChargeCodes } from '@/db/schema';
import { ne, count } from 'drizzle-orm';

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
 *
 * INTERNAL — not a server action. Used by the (app) layout, which has already verified the
 * session itself, and by the admin-guarded getSetupStatus() action for the Setup Wizard UI.
 */
export async function getSetupStatusInternal(): Promise<SetupStatus> {
  const db = await getDb();
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
