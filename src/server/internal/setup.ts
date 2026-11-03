import 'server-only';
import { getDb } from '@/db';
import { chargeCodes, clins, contracts, indirectChargeCodes, laborCategories, slins, userChargeCodes, users } from '@/db/schema';
import { and, asc, count, countDistinct, eq, inArray, notExists, sql } from 'drizzle-orm';
import { CHARGEABLE_CODE } from '@/server/internal/chargeable';
import { EXPECTED_SUBMITTER_ROLES } from '@/server/internal/team-period-status';

export type SetupStepKey = 'indirectCodes' | 'contracts' | 'clins' | 'chargeCodes' | 'laborCategories' | 'employees' | 'chargeCodeAccess';

export interface SetupStatus {
  indirectCodes: number;        // active and available to everyone
  contracts: number;            // active
  clins: number;                // active
  chargeCodes: number;          // chargeable (CHARGEABLE_CODE)
  laborCategories: number;      // active
  employees: number;            // active expected submitters (EXPECTED_SUBMITTER_ROLES: employee, supervisor)
  employeesWithAccess: number;  // of those, with ≥ 1 active assignment to a chargeable code
  isComplete: boolean;          // every required step done
  /**
   * feature-plan-ux-page-fixes.md C17: the access step also carries `allCovered` (every expected submitter has a
   * chargeable code), `withAccess` and `total`; it stays `done` at 1 of N. Names are never here (see getSetupAccessGaps).
   */
  steps: { key: SetupStepKey; done: boolean; required: boolean; allCovered?: boolean; withAccess?: number; total?: number }[];
  done: number;
  total: number;
}

/**
 * Setup status (feature-plan-ux-navigation-home.md §4.7, UX-AUDIT B1): counts what actually makes a timesheet usable.
 * A direct timesheet row appears only for an active `user_charge_codes` assignment to a chargeable code, so that — not
 * CLIN assignments (`user_assignments`, approval scope) — is what "charge code access" counts. INTERNAL, no guard: used
 * by Home (which authorizes) and the admin-guarded getSetupStatus() action. No cache() — callers run it once.
 */
export async function getSetupStatusInternal(): Promise<SetupStatus> {
  const db = await getDb();
  const [indirect, contractRows, clinRows, chargeable, lcats, employeeRows, access] = await Promise.all([
    db.select({ n: count() }).from(indirectChargeCodes)
      .where(and(eq(indirectChargeCodes.isActive, true), eq(indirectChargeCodes.availableToAll, true))),
    db.select({ n: count() }).from(contracts).where(eq(contracts.status, 'active')),
    db.select({ n: count() }).from(clins).where(eq(clins.status, 'active')),
    db.select({ n: count() }).from(chargeCodes)
      .innerJoin(clins, eq(chargeCodes.clinId, clins.id))
      .innerJoin(contracts, eq(clins.contractId, contracts.id))
      .leftJoin(slins, eq(chargeCodes.slinId, slins.id))
      .where(CHARGEABLE_CODE),
    db.select({ n: count() }).from(laborCategories).where(eq(laborCategories.status, 'active')),
    db.select({ n: count() }).from(users).where(and(eq(users.isActive, true), inArray(users.role, [...EXPECTED_SUBMITTER_ROLES]))),
    db.select({ n: countDistinct(users.id) }).from(userChargeCodes)
      .innerJoin(users, eq(userChargeCodes.userId, users.id))
      .innerJoin(chargeCodes, eq(userChargeCodes.chargeCodeId, chargeCodes.id))
      .innerJoin(clins, eq(chargeCodes.clinId, clins.id))
      .innerJoin(contracts, eq(clins.contractId, contracts.id))
      .leftJoin(slins, eq(chargeCodes.slinId, slins.id))
      .where(and(eq(userChargeCodes.isActive, true), eq(users.isActive, true), inArray(users.role, [...EXPECTED_SUBMITTER_ROLES]), CHARGEABLE_CODE)),
  ]);
  const n = (rows: { n: number }[]) => Number(rows[0]?.n ?? 0);
  const counts = {
    indirectCodes: n(indirect),
    contracts: n(contractRows),
    clins: n(clinRows),
    chargeCodes: n(chargeable),
    laborCategories: n(lcats),
    employees: n(employeeRows),
    employeesWithAccess: n(access),
  };
  const steps: SetupStatus['steps'] = [
    { key: 'indirectCodes', done: counts.indirectCodes > 0, required: false },
    { key: 'contracts', done: counts.contracts > 0, required: true },
    { key: 'clins', done: counts.clins > 0, required: true },
    { key: 'chargeCodes', done: counts.chargeCodes > 0, required: true },
    { key: 'laborCategories', done: counts.laborCategories > 0, required: false },
    { key: 'employees', done: counts.employees > 0, required: true },
    {
      key: 'chargeCodeAccess', done: counts.employeesWithAccess > 0, required: true,
      allCovered: counts.employees > 0 && counts.employeesWithAccess >= counts.employees,
      withAccess: counts.employeesWithAccess,
      total: counts.employees,
    },
  ];
  return {
    ...counts,
    isComplete: counts.contracts > 0 && counts.clins > 0 && counts.chargeCodes > 0 && counts.employeesWithAccess > 0,
    steps,
    done: steps.filter((s) => s.done).length,
    total: steps.length,
  };
}

export interface SetupAccessGaps {
  /** Active expected submitters with no active assignment to a chargeable code. */
  missingCount: number;
  /** The first SETUP_GAP_NAMES of them, by name. */
  names: string[];
}

const SETUP_GAP_NAMES = 20;

/**
 * Who still has no direct charge code (feature-plan-ux-page-fixes.md C17): active employees and supervisors with no
 * active assignment to a CHARGEABLE_CODE. Kept off SetupStatus so Home's payload and query count don't change; only the
 * Setup page reads it (through the admin-guarded getSetupAccessGaps action). INTERNAL, no guard.
 */
export async function getSetupAccessGapsInternal(): Promise<SetupAccessGaps> {
  const db = await getDb();
  const chargeableAssignment = db.select({ one: sql`1` }).from(userChargeCodes)
    .innerJoin(chargeCodes, eq(userChargeCodes.chargeCodeId, chargeCodes.id))
    .innerJoin(clins, eq(chargeCodes.clinId, clins.id))
    .innerJoin(contracts, eq(clins.contractId, contracts.id))
    .leftJoin(slins, eq(chargeCodes.slinId, slins.id))
    // The outer users.id is written literally: an interpolated column would bind inside the subquery.
    .where(and(sql`${userChargeCodes.userId} = users.id`, eq(userChargeCodes.isActive, true), CHARGEABLE_CODE));
  const missing = and(eq(users.isActive, true), inArray(users.role, [...EXPECTED_SUBMITTER_ROLES]), notExists(chargeableAssignment));
  const [countRows, nameRows] = await Promise.all([
    db.select({ n: count() }).from(users).where(missing),
    db.select({ name: users.fullName }).from(users).where(missing).orderBy(asc(users.fullName)).limit(SETUP_GAP_NAMES),
  ]);
  return { missingCount: Number(countRows[0]?.n ?? 0), names: nameRows.map((r) => r.name) };
}
