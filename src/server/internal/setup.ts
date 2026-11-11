import 'server-only';
import { getDb } from '@/db';
import {
  approvalScopes, chargeCodes, clins, contracts, indirectChargeCodes, integrationConnections, laborCategories, payPeriodConfig, slins,
  timesheetEntries, timesheetPeriods, userChargeCodes, users, workspaceSettings,
} from '@/db/schema';
import { and, asc, count, countDistinct, eq, inArray, isNotNull, isNull, notExists, sql } from 'drizzle-orm';
import { CHARGEABLE_CODE } from '@/server/internal/chargeable';
import { EXPECTED_SUBMITTER_ROLES } from '@/server/internal/team-period-status';
import { getCurrentEffectiveConfigInternal } from '@/server/internal/pay-period-config';
import { timezoneLabel } from '@/lib/timezone-options';

/**
 * The Setup checklist (feature-plan-ux-setup-import.md §3.1, P2–P4). Six required steps in dependency order, then three
 * recommended. Each step is done only when its condition really holds (P3).
 */
import { REQUIRED_SETUP_STEPS, type SetupStepKey } from '@/lib/setup/steps';
export type { SetupStepKey };

export interface SetupStep {
  key: SetupStepKey;
  done: boolean;
  required: boolean;
  /** chargeCodeAccess only (P3): the covered group w and its size m — counts, never names (C17). */
  withAccess?: number;
  total?: number;
}

export interface SetupCounts {
  indirectCodes: number;        // active and available to everyone
  contracts: number;            // active
  clins: number;                // active
  chargeCodes: number;          // chargeable (CHARGEABLE_CODE)
  laborCategories: number;      // active
  employees: number;            // active expected submitters (employees and supervisors)
  employeesWithAccess: number;  // of those, with ≥ 1 active assignment to a chargeable code
  adminsWithAccess: number;     // active admins with ≥ 1 active assignment to a chargeable code (P3: admins record time)
  clinsWithoutCode: number;     // active CLINs on active contracts with no active charge code
}

/** Lean (Home reads it): counts and booleans only — no names, no detail strings (C17). */
export interface SetupStatus {
  steps: SetupStep[];
  requiredDone: number;
  requiredTotal: typeof REQUIRED_SETUP_STEPS;
  isComplete: boolean;
  counts: SetupCounts;
  hasTimesheetData: boolean;
  /** A pay_period_config row exists (P15: the Import page asks to confirm the schedule before past hours). */
  payConfigSet: boolean;
}

/** The combined statement's one-row FROM (exported so the unit test's fake database can script it). */
export const SETUP_FLAGS_FROM = sql`(select 1) as setup_flags`;

/**
 * The status in at most 8 parallel queries (pool max 10): the 7 counts plus ONE statement of scalar subqueries for the
 * new checks (workweek set, pay config row, timesheet data, connection, CLINs without a code, admins with a code).
 * INTERNAL, no guard: Home (which authorizes) and the admin-guarded actions. No cache() — callers run it once.
 */
export async function getSetupStatusInternal(): Promise<SetupStatus> {
  const db = await getDb();
  const chargeableAccess = (roles: string[]) => db.select({ n: countDistinct(users.id) }).from(userChargeCodes)
    .innerJoin(users, eq(userChargeCodes.userId, users.id))
    .innerJoin(chargeCodes, eq(userChargeCodes.chargeCodeId, chargeCodes.id))
    .innerJoin(clins, eq(chargeCodes.clinId, clins.id))
    .innerJoin(contracts, eq(clins.contractId, contracts.id))
    .leftJoin(slins, eq(chargeCodes.slinId, slins.id))
    .where(and(eq(userChargeCodes.isActive, true), eq(users.isActive, true), inArray(users.role, roles as never), CHARGEABLE_CODE));

  // Scalar subqueries for the one combined statement. Correlated outer columns are written literally (an interpolated
  // column would bind inside the subquery).
  const workweekSetQ = db.select({ v: isNotNull(workspaceSettings.workweekStartDay) }).from(workspaceSettings).where(eq(workspaceSettings.id, 1));
  const payConfigQ = db.select({ one: sql`1` }).from(payPeriodConfig).limit(1);
  const entryQ = db.select({ one: sql`1` }).from(timesheetEntries).limit(1);
  const periodQ = db.select({ one: sql`1` }).from(timesheetPeriods).limit(1);
  const connectionQ = db.select({ one: sql`1` }).from(integrationConnections)
    .where(and(eq(integrationConnections.isActive, true), isNull(integrationConnections.disconnectedAt))).limit(1);
  const codeOnClinQ = db.select({ one: sql`1` }).from(chargeCodes).where(and(sql`${chargeCodes.clinId} = clins.id`, eq(chargeCodes.isActive, true)));
  // Active CLINs on active contracts with no active code at all (a CLIN rule, not the CHARGEABLE_CODE rule).
  const clinsWithoutCodeQ = db.select({ n: count() }).from(clins).innerJoin(contracts, eq(clins.contractId, contracts.id))
    .where(and(eq(contracts.status, 'active'), eq(clins.status, 'active'), notExists(codeOnClinQ)));
  const adminsWithAccessQ = chargeableAccess(['admin']);

  const [indirect, contractRows, clinRows, chargeable, lcats, employeeRows, access, [flags]] = await Promise.all([
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
    chargeableAccess([...EXPECTED_SUBMITTER_ROLES]),
    db.select({
      workweekSet: sql<boolean>`coalesce((${workweekSetQ}), false)`,
      payConfigSet: sql<boolean>`exists(${payConfigQ})`,
      hasTimesheetData: sql<boolean>`(exists(${entryQ}) or exists(${periodQ}))`,
      connection: sql<boolean>`exists(${connectionQ})`,
      clinsWithoutCode: sql<number>`(${clinsWithoutCodeQ})`.mapWith(Number),
      adminsWithAccess: sql<number>`(${adminsWithAccessQ})`.mapWith(Number),
    }).from(SETUP_FLAGS_FROM),
  ]);
  const n = (rows: { n: number }[]) => Number(rows[0]?.n ?? 0);
  const counts: SetupCounts = {
    indirectCodes: n(indirect),
    contracts: n(contractRows),
    clins: n(clinRows),
    chargeCodes: n(chargeable),
    laborCategories: n(lcats),
    employees: n(employeeRows),
    employeesWithAccess: n(access),
    adminsWithAccess: Number(flags?.adminsWithAccess ?? 0),
    clinsWithoutCode: Number(flags?.clinsWithoutCode ?? 0),
  };
  const hasTimesheetData = flags?.hasTimesheetData === true;
  // P3: the covered group is submitters with a chargeable code plus admins with one; its size adds those admins to the
  // submitters (an admin who records no direct time isn't counted).
  const withAccess = counts.employeesWithAccess + counts.adminsWithAccess;
  const total = counts.employees + counts.adminsWithAccess;
  const steps: SetupStep[] = [
    { key: 'timeAndWeek', required: true, done: flags?.workweekSet === true },
    { key: 'paySchedule', required: true, done: flags?.payConfigSet === true || hasTimesheetData },
    { key: 'contractsClins', required: true, done: counts.contracts > 0 && counts.clins > 0 },
    { key: 'chargeCodes', required: true, done: counts.chargeCodes > 0 },
    { key: 'people', required: true, done: counts.employees > 0 || counts.adminsWithAccess > 0 },
    { key: 'chargeCodeAccess', required: true, done: withAccess > 0, withAccess, total },
    { key: 'indirectCodes', required: false, done: counts.indirectCodes > 0 },
    { key: 'laborCategories', required: false, done: counts.laborCategories > 0 },
    { key: 'connection', required: false, done: flags?.connection === true },
  ];
  const required = steps.filter((s) => s.required);
  return {
    steps,
    requiredDone: required.filter((s) => s.done).length,
    requiredTotal: REQUIRED_SETUP_STEPS,
    isComplete: required.every((s) => s.done),
    counts,
    hasTimesheetData,
    payConfigSet: flags?.payConfigSet === true,
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
 * active assignment to a CHARGEABLE_CODE. Kept off SetupStatus so Home's payload doesn't carry names; only the Setup page
 * reads it (through getSetupPageData). INTERNAL, no guard.
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

export interface SetupPageData {
  status: SetupStatus;
  gaps: SetupAccessGaps;
  settings: {
    timezone: string;
    /** The time zone's friendly name for the checklist (S10), computed here so the server and browser render the same text. */
    timezoneLabel: string;
    workweekStartDay: number | null;
    /** The current pay schedule (`set` = a pay_period_config row exists; otherwise the default is in use). */
    payConfig: { set: boolean; periodType: string; anchorDate: string; weekStartDay: number };
    /** The first active connection's display name (the recommended step's detail), if any. */
    connectionName: string | null;
  };
  /** Active approval scopes (the Import page's type list). */
  scopeCount: number;
}

/**
 * The Setup page's (and the Import page's type list's) data: the lean status, then — after it, never alongside its 8
 * queries — the gaps and the settings. INTERNAL; the action guards.
 */
export async function getSetupPageDataInternal(): Promise<SetupPageData> {
  const status = await getSetupStatusInternal();
  const db = await getDb();
  const [gaps, [settings], config, [connection], [scopes]] = await Promise.all([
    getSetupAccessGapsInternal(),
    db.select({ timezone: workspaceSettings.timezone, workweekStartDay: workspaceSettings.workweekStartDay }).from(workspaceSettings).where(eq(workspaceSettings.id, 1)),
    getCurrentEffectiveConfigInternal(),   // the schedule in effect today (the default when there's no row)
    db.select({ name: integrationConnections.displayName }).from(integrationConnections)
      .where(and(eq(integrationConnections.isActive, true), isNull(integrationConnections.disconnectedAt))).orderBy(asc(integrationConnections.connectedAt)).limit(1),
    db.select({ n: count() }).from(approvalScopes).where(eq(approvalScopes.isActive, true)),
  ]);
  return {
    status,
    gaps,
    settings: {
      timezone: settings?.timezone ?? 'America/New_York',
      timezoneLabel: timezoneLabel(settings?.timezone ?? 'America/New_York'),
      workweekStartDay: settings?.workweekStartDay ?? null,
      payConfig: { set: status.payConfigSet, periodType: config.periodType, anchorDate: config.anchorDate, weekStartDay: config.weekStartDay },
      connectionName: connection?.name ?? null,
    },
    scopeCount: Number(scopes?.n ?? 0),
  };
}
