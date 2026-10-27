import 'server-only';
import { asc, eq, sql, type SQL } from 'drizzle-orm';
import type { DbTx, ReadDb } from '@/db';
import { chargeCodeLaborCategories, chargeCodes, laborCategories, laborCategoryRates } from '@/db/schema';
import type { CalendarDate } from '@/lib/calendar-date';
import type { CategorySchedule, RateSchedule } from '@/lib/labor-rates';

/**
 * Dated labor-category rates — the SQL side (feature-plan-dated-rates.md D1.3) and the schedule readers the rate
 * actions use. INTERNAL: callers authorize first; every function takes the caller's client.
 */

/**
 * Hourly rate (NUMERIC) of a category on a day; NULL when the category is NULL. The ONLY SQL rate rule (pure twin:
 * rateOn in src/lib/labor-rates.ts). Arguments are SQL FRAGMENTS (e.g. sql`${laborCategories.id}`), typed `SQL` so a
 * value can't be passed. Both COALESCE arguments are varchar; the single cast is outside (trap T6). Internal aliases are
 * prefixed (dr_rate / dr_start) so a caller's fragment can never be captured by them (trap T16, dated-rates audit H1).
 */
export function hourlyRateOnSql(args: { laborCategoryId: SQL; onDate: SQL }): SQL<string> {
  const { laborCategoryId, onDate } = args;
  return sql<string>`CAST(COALESCE(
    (SELECT dr_rate.hourly_rate FROM labor_category_rates dr_rate
      WHERE dr_rate.labor_category_id = ${laborCategoryId} AND dr_rate.effective_date <= ${onDate}
      ORDER BY dr_rate.effective_date DESC LIMIT 1),
    (SELECT dr_start.hourly_rate FROM labor_categories dr_start WHERE dr_start.id = ${laborCategoryId})
  ) AS NUMERIC)`;
}

type Reader = Pick<ReadDb, 'select'> | DbTx;

async function readChanges(db: Reader, laborCategoryId: string): Promise<RateSchedule['changes']> {
  const rows = await db
    .select({ id: laborCategoryRates.id, effectiveDate: laborCategoryRates.effectiveDate, hourlyRate: laborCategoryRates.hourlyRate, ceilingRate: laborCategoryRates.ceilingRate })
    .from(laborCategoryRates)
    .where(eq(laborCategoryRates.laborCategoryId, laborCategoryId))
    .orderBy(asc(laborCategoryRates.effectiveDate));
  return rows.map((r) => ({ id: r.id, effectiveDate: r.effectiveDate as CalendarDate, hourlyRate: r.hourlyRate, ceilingRate: r.ceilingRate ?? null }));
}

/**
 * Lock the category row FOR NO KEY UPDATE (serializes every rate write for it without blocking FK inserts — trap T15)
 * and read its schedule. Null when the category doesn't exist.
 */
export async function lockAndReadSchedule(tx: DbTx, laborCategoryId: string): Promise<RateSchedule | null> {
  const [row] = await tx
    .select({ hourlyRate: laborCategories.hourlyRate, ceilingRate: laborCategories.ceilingRate })
    .from(laborCategories)
    .where(eq(laborCategories.id, laborCategoryId))
    .for('no key update');
  if (!row) return null;
  return { starting: { hourlyRate: row.hourlyRate, ceilingRate: row.ceilingRate ?? null }, changes: await readChanges(tx, laborCategoryId) };
}

/** The schedule without a lock (the preview, and the value actions return). Null when the category doesn't exist. */
export async function readRateSchedule(db: Reader, laborCategoryId: string): Promise<RateSchedule | null> {
  const [row] = await db
    .select({ hourlyRate: laborCategories.hourlyRate, ceilingRate: laborCategories.ceilingRate })
    .from(laborCategories)
    .where(eq(laborCategories.id, laborCategoryId));
  if (!row) return null;
  return { starting: { hourlyRate: row.hourlyRate, ceilingRate: row.ceilingRate ?? null }, changes: await readChanges(db, laborCategoryId) };
}

// ── D3: a charge code's dated labor category ───────────────────────────────────────────────────────────────────

/**
 * Labor category (uuid) of a charge code on a day; NULL when the code is NULL or has no category then. The ONLY SQL rule
 * for it (pure twin: chargeCodeCategoryOn). `SQL` fragment arguments and prefixed internal aliases (dr_cc_change /
 * dr_cc_start), like hourlyRateOnSql.
 */
export function chargeCodeLaborCategoryOnSql(args: { chargeCodeId: SQL; onDate: SQL }): SQL<string | null> {
  const { chargeCodeId, onDate } = args;
  return sql<string | null>`COALESCE(
    (SELECT dr_cc_change.labor_category_id FROM charge_code_labor_categories dr_cc_change
      WHERE dr_cc_change.charge_code_id = ${chargeCodeId} AND dr_cc_change.effective_date <= ${onDate}
      ORDER BY dr_cc_change.effective_date DESC LIMIT 1),
    (SELECT dr_cc_start.labor_category_id FROM charge_codes dr_cc_start WHERE dr_cc_start.id = ${chargeCodeId})
  )`;
}

async function readCategoryChanges(db: Reader, chargeCodeId: string): Promise<CategorySchedule['changes']> {
  const rows = await db
    .select({ id: chargeCodeLaborCategories.id, effectiveDate: chargeCodeLaborCategories.effectiveDate, laborCategoryId: chargeCodeLaborCategories.laborCategoryId })
    .from(chargeCodeLaborCategories)
    .where(eq(chargeCodeLaborCategories.chargeCodeId, chargeCodeId))
    .orderBy(asc(chargeCodeLaborCategories.effectiveDate));
  return rows.map((r) => ({ id: r.id, effectiveDate: r.effectiveDate as CalendarDate, laborCategoryId: r.laborCategoryId }));
}

export interface CodeCategoryState { code: { clinId: string; slinId: string | null }; schedule: CategorySchedule }

/** Lock the charge code row FOR NO KEY UPDATE and read its category schedule (D3). Null when the code doesn't exist. */
export async function lockAndReadCategorySchedule(tx: DbTx, chargeCodeId: string): Promise<CodeCategoryState | null> {
  const [row] = await tx
    .select({ clinId: chargeCodes.clinId, slinId: chargeCodes.slinId, laborCategoryId: chargeCodes.laborCategoryId })
    .from(chargeCodes)
    .where(eq(chargeCodes.id, chargeCodeId))
    .for('no key update');
  if (!row) return null;
  return { code: { clinId: row.clinId, slinId: row.slinId ?? null }, schedule: { starting: row.laborCategoryId ?? null, changes: await readCategoryChanges(tx, chargeCodeId) } };
}

/** The category schedule without a lock (preview / return value). Null when the code doesn't exist. */
export async function readCategorySchedule(db: Reader, chargeCodeId: string): Promise<CodeCategoryState | null> {
  const [row] = await db
    .select({ clinId: chargeCodes.clinId, slinId: chargeCodes.slinId, laborCategoryId: chargeCodes.laborCategoryId })
    .from(chargeCodes)
    .where(eq(chargeCodes.id, chargeCodeId));
  if (!row) return null;
  return { code: { clinId: row.clinId, slinId: row.slinId ?? null }, schedule: { starting: row.laborCategoryId ?? null, changes: await readCategoryChanges(db, chargeCodeId) } };
}

/** A labor category's CLIN / SLIN (DR-Q2 check); null when it doesn't exist. */
export async function readCategoryPlacement(db: Reader, laborCategoryId: string): Promise<{ clinId: string; slinId: string | null } | null> {
  const [row] = await db.select({ clinId: laborCategories.clinId, slinId: laborCategories.slinId }).from(laborCategories).where(eq(laborCategories.id, laborCategoryId));
  return row ? { clinId: row.clinId, slinId: row.slinId ?? null } : null;
}
