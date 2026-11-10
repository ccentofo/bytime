'use server';

import { getDbForWrite, type DbTx } from '@/db';
import { users, contracts, clins, slins, laborCategories, approvalScopes, chargeCodes, userChargeCodes } from '@/db/schema';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { requireAdminFresh } from '@/lib/session';
import { assertSeatsAvailable } from '@/server/internal/seats';
import { loadApprovalFacts, lockUserRulesExclusive, newlyEligible, recomputeSelfApproval, scopeChange, snapshotSubmittedEligibility } from '@/server/internal/approval-rules';
import { UNREVIEWED_MIGRATED_SCOPE, grantScopeRows } from '@/server/internal/approval-scopes';
import { UserFacingError } from '@/lib/errors';
import { generateImportPassword } from '@/server/internal/generated-password';
import { notifyReroutedApprovals } from '@/server/internal/submission-notify';
import bcrypt from 'bcryptjs';
import { importRowMessage, parseImportDate } from '@/server/internal/import-errors';
import { catchDryRun, throwIfDryRun } from '@/server/internal/import-run';
import { validateClinInput, validateContractInput, validateLaborCategoryInput } from '@/server/internal/setup-validators';
import { assignChargeCodeToUserInternal, createChargeCodeInternal, validateChargeCodeInput } from '@/server/internal/charge-codes';
import { CHARGEABLE_CODE } from '@/server/internal/chargeable';
import { userAction, type ActionResult } from '@/lib/action-result';
import { validateEmail, validateRequired, validateStringLength } from '@/lib/validation';
import { logAdminChange } from '@/server/internal/admin-change-log';
import {
  IMPORT_ROW_LIMIT, SKIP_REASON, hasInvalidCharacter, invalidCharacterMessage, rowNumberOf, strictMoney, strictRate, tooManyRowsMessage,
  type SetupImportType,
} from '@/lib/import/limits';

/*
 * The setup imports (feature-plan-ux-setup-import.md P9–P13, §4.3). Every one: `requireAdminFresh` first; the per-type
 * row limit; ONE transaction with a savepoint per row — everything a row does (lookups, validators, inserts) runs on its
 * savepoint `sp`, so a failed query rolls back only that row (postgres-js rethrows a failed query on the outer `tx` at
 * the end, even if caught). Row numbers are the spreadsheet rows the browser sends; bad values are refused, never
 * coerced; existing records are skipped with a reason. `dryRun: true` runs the identical code and rolls back
 * (throwIfDryRun / catchDryRun): nothing is written, nobody is emailed, no passwords come back, and unexpected row errors
 * aren't reported to Sentry.
 */

export interface ImportResult {
  created: number;
  skipped: number;
  errors: { row: number; message: string }[];
  /** Existing records left alone, with the reason (the check table shows them as skipped). */
  skippedRows: { row: number; reason: string }[];
  generatedPasswords?: { email: string; password: string }[];
}

export interface ImportOptions { dryRun?: boolean }

/** A row as the browser sends it: its spreadsheet row number plus the fields. */
type WithRow<T> = T & { row?: number };

type RowOutcome = { created: true; password?: { email: string; password: string } } | { skipped: string };

const emptyResult = (): ImportResult => ({ created: 0, skipped: 0, errors: [], skippedRows: [] });

/** The batch-level checks: an array within the type's limit (P13, the server's re-check). */
function assertRows(type: SetupImportType, rows: unknown): asserts rows is unknown[] {
  if (!Array.isArray(rows)) throw new UserFacingError('Nothing to import.');
  if (rows.length > IMPORT_ROW_LIMIT[type]) throw new UserFacingError(tooManyRowsMessage(rows.length, IMPORT_ROW_LIMIT[type]));
}

/** A cell as a trimmed string (spreadsheets can hand over numbers and nulls). */
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : v === null || v === undefined ? '' : String(v).trim());

/**
 * §4.3: a control character anywhere in a row refuses that row BEFORE any batch-level query (Postgres rejects a NUL, and
 * a failed query on the outer transaction would abort it). Returns the rows that go on, with their row numbers.
 */
function screenRows<T extends object>(rows: WithRow<T>[], result: ImportResult): Array<{ row: WithRow<T>; rowNo: number }> {
  const out: Array<{ row: WithRow<T>; rowNo: number }> = [];
  rows.forEach((row, i) => {
    const rowNo = rowNumberOf(row, i);
    if (!row || typeof row !== 'object') result.errors.push({ row: rowNo, message: 'Could not import this row.' });
    else if (hasInvalidCharacter(row)) result.errors.push({ row: rowNo, message: invalidCharacterMessage(rowNo) });
    else out.push({ row, rowNo });
  });
  return out;
}

/** One row in its own savepoint; the outcome is counted, a throw is reported against the row. */
async function runRow(
  tx: DbTx, result: ImportResult, rowNo: number, duplicateFallback: string, dryRun: boolean,
  fn: (sp: DbTx) => Promise<RowOutcome>,
): Promise<void> {
  try {
    const outcome = await tx.transaction(fn);
    if ('skipped' in outcome) {
      result.skipped++;
      result.skippedRows.push({ row: rowNo, reason: outcome.skipped });
    } else {
      result.created++;
      if (outcome.password) result.generatedPasswords?.push(outcome.password);
    }
  } catch (error) {
    result.errors.push({ row: rowNo, message: importRowMessage(error, duplicateFallback, { dryRun }) });
  }
}

/** Errors and skips in spreadsheet order (screening reports some rows before the others run). */
const byRow = (r: ImportResult): ImportResult => ({
  ...r, errors: [...r.errors].sort((a, b) => a.row - b.row), skippedRows: [...r.skippedRows].sort((a, b) => a.row - b.row),
});

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export interface EmployeeImportRow {
  name: string;
  email: string;
  role: string;
  flsaExempt: string;
}

const ROLES = { employee: 'employee', supervisor: 'supervisor', admin: 'admin' } as const;

/** P12: Employee / Supervisor / Admin (any case); anything else — blank included — is refused. */
function parseRole(value: unknown): (typeof ROLES)[keyof typeof ROLES] {
  const role = ROLES[text(value).toLowerCase() as keyof typeof ROLES];
  if (!role) throw new UserFacingError('Role must be Employee, Supervisor or Admin.');
  return role;
}

/** P12: Yes / No / True / False (any case); anything else — blank included — is refused (R7: overtime status is required). */
function parseFlsa(value: unknown): boolean {
  const v = text(value).toLowerCase();
  if (v === 'yes' || v === 'true') return true;
  if (v === 'no' || v === 'false') return false;
  throw new UserFacingError('Overtime (FLSA Exempt) must be Yes or No.');
}

export async function bulkImportEmployees(rows: WithRow<EmployeeImportRow>[], options: ImportOptions = {}): Promise<ActionResult<ImportResult>> {
  return userAction(async () => {
    const actor = await requireAdminFresh();
    assertRows('people', rows);
    const dryRun = options?.dryRun === true;
    const db = await getDbForWrite();
    const result: ImportResult = { ...emptyResult(), generatedPasswords: [] };

    // P12 values first (no database): a refused row never counts towards the seat check.
    const candidates: Array<{ rowNo: number; name: string; email: string; role: (typeof ROLES)[keyof typeof ROLES]; flsaExempt: boolean }> = [];
    for (const { row, rowNo } of screenRows(rows, result)) {
      try {
        const name = validateStringLength(validateRequired(text(row.name), 'Name'), 'Name', 1, 255);
        const email = validateEmail(text(row.email));
        candidates.push({ rowNo, name, email, role: parseRole(row.role), flsaExempt: parseFlsa(row.flsaExempt) });
      } catch (error) {
        result.errors.push({ row: rowNo, message: importRowMessage(error, 'That employee already exists.', { dryRun }) });
      }
    }
    const incomingEmails = [...new Set(candidates.map((c) => c.email))];

    // certified-outputs C2 (CO-D19, ruling Q5): one transaction with the self-approval recompute and the re-routing
    // snapshot. R2-11: the batch is refused up front if its genuinely new, valid users would exceed the plan's seats.
    const { result: done, rerouted } = await catchDryRun(db.transaction(async (tx) => {
      await lockUserRulesExclusive(tx); // F1: first statement, before any row lock
      const existingRows = incomingEmails.length > 0
        ? await tx.select({ email: users.email }).from(users).where(inArray(users.email, incomingEmails))
        : [];
      const existingEmails = new Set(existingRows.map((r) => r.email.toLowerCase()));
      const newRowCount = incomingEmails.filter((email) => !existingEmails.has(email)).length;
      if (newRowCount > 0) await assertSeatsAvailable(newRowCount, tx);

      const beforeFacts = await loadApprovalFacts(tx);
      const before = await snapshotSubmittedEligibility(tx, beforeFacts);
      for (const c of candidates) {
        await runRow(tx, result, c.rowNo, 'That employee already exists.', dryRun, async (sp) => {
          const [existing] = await sp.select({ id: users.id }).from(users).where(eq(users.email, c.email));
          if (existing) return { skipped: SKIP_REASON.user };
          const password = generateImportPassword();
          const hash = await bcrypt.hash(password, 4); // Low cost for bulk
          const [created] = await sp.insert(users).values({
            email: c.email, fullName: c.name, role: c.role, passwordHash: hash, isActive: true, flsaExempt: c.flsaExempt,
          }).returning({ id: users.id });
          // feature-plan-ux-people-codes.md R5: logged in the row's own savepoint (a failed row logs nothing).
          await logAdminChange(sp, { actorId: actor.id, entity: 'user', entityId: created.id, action: 'created', oldValue: null, newValue: { role: c.role, flsaExempt: c.flsaExempt } });
          return { created: true, password: { email: c.email, password } };
        });
      }
      if (result.created > 0) await recomputeSelfApproval(tx, actor.id, `${result.created} user(s) imported`, { before: beforeFacts });
      const changed = result.created > 0 ? newlyEligible(before, await snapshotSubmittedEligibility(tx)) : [];
      return throwIfDryRun(dryRun, { result: byRow(result), rerouted: changed });
    }));
    if (!dryRun) await notifyReroutedApprovals(rerouted);
    return done;
  });
}

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

export interface ContractImportRow {
  contractNumber: string;
  name: string;
  type?: string;
  fundedValue?: string;
  ceilingValue?: string;
  startDate?: string;
  endDate?: string;
}

/** P12: Type blank → prime; `prime` or `sub` (any case); anything else is refused. */
function parseContractType(value: unknown): 'prime' | 'sub' {
  const v = text(value).toLowerCase();
  if (v === '' || v === 'prime') return 'prime';
  if (v === 'sub') return 'sub';
  throw new UserFacingError('Type must be blank (prime), prime or sub.');
}

export async function bulkImportContracts(rows: WithRow<ContractImportRow>[], options: ImportOptions = {}): Promise<ActionResult<ImportResult>> {
  return userAction(async () => {
    await requireAdminFresh();
    assertRows('contracts', rows);
    const dryRun = options?.dryRun === true;
    const db = await getDbForWrite();
    const result = emptyResult();
    const screened = screenRows(rows, result);
    return catchDryRun(db.transaction(async (tx) => {
      for (const { row, rowNo } of screened) {
        await runRow(tx, result, rowNo, 'That contract already exists.', dryRun, async (sp) => {
          const startDate = text(row.startDate);
          const endDate = text(row.endDate);
          const values = validateContractInput({
            contractNumber: text(row.contractNumber),
            name: text(row.name),
            contractType: parseContractType(row.type),
            fundedValue: strictMoney(row.fundedValue, 'Funded Value') ?? undefined,
            ceilingValue: strictMoney(row.ceilingValue, 'Ceiling Value') ?? undefined,
            startDate: startDate ? parseImportDate(startDate, 'Start date') : undefined,
            endDate: endDate ? parseImportDate(endDate, 'End date') : undefined,
          });
          const [existing] = await sp.select({ id: contracts.id }).from(contracts).where(eq(contracts.contractNumber, values.contractNumber));
          if (existing) return { skipped: SKIP_REASON.contract };
          await sp.insert(contracts).values({ ...values, status: 'active' });
          return { created: true };
        });
      }
      return throwIfDryRun(dryRun, byRow(result));
    }));
  });
}

// ---------------------------------------------------------------------------
// CLINs
// ---------------------------------------------------------------------------

export interface ClinImportRow {
  contractNumber: string;
  clinNumber: string;
  description?: string;
  fundedAmount?: string;
}

export async function bulkImportClins(rows: WithRow<ClinImportRow>[], options: ImportOptions = {}): Promise<ActionResult<ImportResult>> {
  return userAction(async () => {
    await requireAdminFresh();
    assertRows('clins', rows);
    const dryRun = options?.dryRun === true;
    const db = await getDbForWrite();
    const result = emptyResult();
    const screened = screenRows(rows, result);
    return catchDryRun(db.transaction(async (tx) => {
      for (const { row, rowNo } of screened) {
        await runRow(tx, result, rowNo, 'That CLIN already exists under this contract.', dryRun, async (sp) => {
          const contractNumber = text(row.contractNumber);
          const [contract] = await sp.select({ id: contracts.id }).from(contracts).where(eq(contracts.contractNumber, contractNumber));
          if (!contract) throw new UserFacingError(`Contract "${contractNumber}" not found`);
          const values = await validateClinInput(sp, {
            contractId: contract.id,
            clinNumber: text(row.clinNumber),
            description: text(row.description) || undefined,
            fundedAmount: strictMoney(row.fundedAmount, 'Funded Amount') ?? undefined,
          });
          const [existing] = await sp.select({ id: clins.id }).from(clins)
            .where(and(eq(clins.contractId, contract.id), eq(clins.clinNumber, values.clinNumber)));
          if (existing) return { skipped: SKIP_REASON.clin };
          await sp.insert(clins).values({ ...values, status: 'active' });
          return { created: true };
        });
      }
      return throwIfDryRun(dryRun, byRow(result));
    }));
  });
}

// ---------------------------------------------------------------------------
// Labor categories
// ---------------------------------------------------------------------------

export interface LcatImportRow {
  contractNumber: string;
  clinNumber: string;
  lcatCode: string;
  title: string;
  hourlyRate: string;
  ceilingRate?: string;
}

export async function bulkImportLaborCategories(rows: WithRow<LcatImportRow>[], options: ImportOptions = {}): Promise<ActionResult<ImportResult>> {
  return userAction(async () => {
    await requireAdminFresh();
    assertRows('laborCategories', rows);
    const dryRun = options?.dryRun === true;
    const db = await getDbForWrite();
    const result = emptyResult();
    const screened = screenRows(rows, result);
    return catchDryRun(db.transaction(async (tx) => {
      for (const { row, rowNo } of screened) {
        await runRow(tx, result, rowNo, 'That labor category already exists on this CLIN.', dryRun, async (sp) => {
          const contractNumber = text(row.contractNumber);
          const clinNumber = text(row.clinNumber);
          const [contract] = await sp.select({ id: contracts.id }).from(contracts).where(eq(contracts.contractNumber, contractNumber));
          if (!contract) throw new UserFacingError(`Contract "${contractNumber}" not found`);
          const [clin] = await sp.select({ id: clins.id }).from(clins).where(and(eq(clins.contractId, contract.id), eq(clins.clinNumber, clinNumber)));
          if (!clin) throw new UserFacingError(`CLIN "${clinNumber}" not found under contract "${contractNumber}"`);
          // P12 strict rates first; then validateRate (dated rates D1.6: an unparseable stored rate would make every
          // pricing query fail on its cast). A blank ceiling is none.
          const values = validateLaborCategoryInput({
            lcatCode: text(row.lcatCode),
            title: text(row.title),
            hourlyRate: strictRate(row.hourlyRate, 'Hourly Rate', true),
            ceilingRate: strictRate(row.ceilingRate, 'Ceiling Rate') ?? undefined,
          });
          const [existing] = await sp.select({ id: laborCategories.id }).from(laborCategories)
            .where(and(eq(laborCategories.clinId, clin.id), eq(laborCategories.lcatCode, values.lcatCode)));
          if (existing) return { skipped: SKIP_REASON.laborCategory };
          await sp.insert(laborCategories).values({ ...values, clinId: clin.id, status: 'active' });
          return { created: true };
        });
      }
      return throwIfDryRun(dryRun, byRow(result));
    }));
  });
}

// ---------------------------------------------------------------------------
// Approval scope (the "assignments" type)
// ---------------------------------------------------------------------------

export interface AssignmentImportRow {
  email: string;
  contractNumber: string;
  clinNumber: string;
}

/**
 * The import's approval-scope type (feature-plan-approval-scope.md S7, §4.2): each row lets one supervisor approve
 * employees on one CLIN. Up to 500 rows under ONE scopeChange (the user-rules lock first; waiting timesheets re-route
 * once, and never on a check); each row in its own savepoint. An already-active scope is skipped; a converted one nobody
 * has reviewed is marked kept (APPROVAL-SCOPE-AUDIT.md L4) and the skip reason says so.
 */
export async function bulkImportAssignments(rows: WithRow<AssignmentImportRow>[], options: ImportOptions = {}): Promise<ActionResult<ImportResult>> {
  return userAction(async () => {
    const actor = await requireAdminFresh();
    assertRows('approvalScope', rows);
    const dryRun = options?.dryRun === true;
    const db = await getDbForWrite();
    const result = emptyResult();
    const screened = screenRows(rows, result);
    const { result: done, rerouted } = await catchDryRun(scopeChange(db, async (tx) => {
      for (const { row, rowNo } of screened) {
        await runRow(tx, result, rowNo, 'That approval scope already exists.', dryRun, async (sp) => {
          // Row messages echo the TRIMMED values (APPROVAL-SCOPE-AUDIT.md L2); the lookup is case-insensitive.
          const shownEmail = text(row.email);
          const contractNumber = text(row.contractNumber);
          const clinNumber = text(row.clinNumber);
          const [user] = await sp.select({ id: users.id, role: users.role, isActive: users.isActive }).from(users).where(eq(users.email, shownEmail.toLowerCase()));
          if (!user) throw new UserFacingError(`User "${shownEmail}" not found`);
          if (!user.isActive || user.role !== 'supervisor') throw new UserFacingError(`${shownEmail} isn't an active supervisor, so they can't approve a CLIN.`);
          const [clin] = await sp.select({ id: clins.id, status: clins.status, contractStatus: contracts.status })
            .from(clins).innerJoin(contracts, eq(clins.contractId, contracts.id))
            .where(and(eq(contracts.contractNumber, contractNumber), eq(clins.clinNumber, clinNumber)));
          if (!clin) throw new UserFacingError(`CLIN "${clinNumber}" not found under contract "${contractNumber}"`);
          if (clin.status !== 'active' || clin.contractStatus !== 'active') throw new UserFacingError(`CLIN "${clinNumber}" under contract "${contractNumber}" isn't active.`);
          const [held] = await sp.select({ needsReview: sql<boolean>`(${UNREVIEWED_MIGRATED_SCOPE})` }).from(approvalScopes)
            .where(and(eq(approvalScopes.supervisorId, user.id), eq(approvalScopes.clinId, clin.id), eq(approvalScopes.isActive, true)));
          const granted = await grantScopeRows(sp, { actorId: actor.id, supervisorId: user.id, clinIds: [clin.id], source: 'import' });
          if (granted.length > 0) return { created: true };
          return { skipped: held?.needsReview ? `${SKIP_REASON.scope} (now marked as kept)` : SKIP_REASON.scope };
        });
      }
      return byRow(result);
    }, { dryRun }));
    if (!dryRun) await notifyReroutedApprovals(rerouted);
    return done;
  });
}

// ---------------------------------------------------------------------------
// Charge codes
// ---------------------------------------------------------------------------

export interface ChargeCodeImportRow {
  code: string;
  name: string;
  contractNumber: string;
  clinNumber: string;
  slinNumber?: string;
  laborCategory?: string;
  location?: string;
  billable?: string;
  description?: string;
}

/** P12: Billable Yes / No (True / False too); blank → billable. */
function parseBillable(value: unknown): boolean {
  const v = text(value).toLowerCase();
  if (v === '' || v === 'yes' || v === 'true') return true;
  if (v === 'no' || v === 'false') return false;
  throw new UserFacingError('Billable must be Yes or No.');
}

/**
 * The charge-code type (§4.3): the numbers resolve to the CLIN (and SLIN on it), the LCAT code to an active category on
 * that CLIN; then the same rules as createChargeCode (validateChargeCodeInput: lengths, active CLIN, SLIN on CLIN, the
 * Location values, the category's fit). An existing code is skipped.
 */
export async function bulkImportChargeCodes(rows: WithRow<ChargeCodeImportRow>[], options: ImportOptions = {}): Promise<ActionResult<ImportResult>> {
  return userAction(async () => {
    await requireAdminFresh();
    assertRows('chargeCodes', rows);
    const dryRun = options?.dryRun === true;
    const db = await getDbForWrite();
    const result = emptyResult();
    const screened = screenRows(rows, result);
    return catchDryRun(db.transaction(async (tx) => {
      for (const { row, rowNo } of screened) {
        await runRow(tx, result, rowNo, 'That charge code already exists.', dryRun, async (sp) => {
          const code = text(row.code);
          if (code) {
            const [existing] = await sp.select({ id: chargeCodes.id }).from(chargeCodes).where(eq(chargeCodes.code, code));
            if (existing) return { skipped: SKIP_REASON.chargeCode };
          }
          const contractNumber = text(row.contractNumber);
          const clinNumber = text(row.clinNumber);
          const [clin] = await sp.select({ id: clins.id }).from(clins).innerJoin(contracts, eq(clins.contractId, contracts.id))
            .where(and(eq(contracts.contractNumber, contractNumber), eq(clins.clinNumber, clinNumber)));
          if (!clin) throw new UserFacingError(`CLIN "${clinNumber}" not found under contract "${contractNumber}"`);
          const slinNumber = text(row.slinNumber);
          let slinId: string | null = null;
          if (slinNumber) {
            const [slin] = await sp.select({ id: slins.id }).from(slins).where(and(eq(slins.clinId, clin.id), eq(slins.slinNumber, slinNumber)));
            if (!slin) throw new UserFacingError(`SLIN "${slinNumber}" isn't on CLIN ${clinNumber}.`);
            slinId = slin.id;
          }
          const lcatCode = text(row.laborCategory);
          let laborCategoryId: string | null = null;
          if (lcatCode) {
            const [category] = await sp.select({ id: laborCategories.id }).from(laborCategories)
              .where(and(eq(laborCategories.clinId, clin.id), eq(laborCategories.lcatCode, lcatCode), eq(laborCategories.status, 'active')));
            if (!category) throw new UserFacingError(`Labor category "${lcatCode}" isn't on CLIN ${clinNumber}.`);
            laborCategoryId = category.id;
          }
          const input = await validateChargeCodeInput(sp, {
            code, name: text(row.name), description: text(row.description) || undefined, clinId: clin.id, slinId, laborCategoryId,
            workLocation: text(row.location).toLowerCase() || null,
            billable: parseBillable(row.billable),
          });
          await createChargeCodeInternal(sp, input);
          return { created: true };
        });
      }
      return throwIfDryRun(dryRun, byRow(result));
    }));
  });
}

// ---------------------------------------------------------------------------
// Charge code access
// ---------------------------------------------------------------------------

export interface ChargeCodeAccessImportRow {
  email: string;
  chargeCode: string;
}

/**
 * The charge-code access type (§4.3): an active person and a code that can be charged (CHARGEABLE_CODE). Access already
 * held is skipped; otherwise assignChargeCodeToUserInternal (which also upserts the CLIN membership row), as
 * assignChargeCodesToUser does.
 */
export async function bulkImportChargeCodeAccess(rows: WithRow<ChargeCodeAccessImportRow>[], options: ImportOptions = {}): Promise<ActionResult<ImportResult>> {
  return userAction(async () => {
    const actor = await requireAdminFresh();
    assertRows('chargeCodeAccess', rows);
    const dryRun = options?.dryRun === true;
    const db = await getDbForWrite();
    const result = emptyResult();
    const screened = screenRows(rows, result);
    return catchDryRun(db.transaction(async (tx) => {
      for (const { row, rowNo } of screened) {
        await runRow(tx, result, rowNo, 'That access already exists.', dryRun, async (sp) => {
          const shownEmail = text(row.email);
          const code = text(row.chargeCode);
          const [user] = await sp.select({ id: users.id, isActive: users.isActive }).from(users).where(eq(users.email, shownEmail.toLowerCase()));
          if (!user) throw new UserFacingError(`User "${shownEmail}" not found`);
          if (!user.isActive) throw new UserFacingError(`${shownEmail} isn't active, so they can't be given access.`);
          const [found] = await sp.select({ id: chargeCodes.id, chargeable: sql<boolean>`${CHARGEABLE_CODE}`.mapWith(Boolean) })
            .from(chargeCodes)
            .innerJoin(clins, eq(chargeCodes.clinId, clins.id))
            .innerJoin(contracts, eq(clins.contractId, contracts.id))
            .leftJoin(slins, eq(chargeCodes.slinId, slins.id))
            .where(eq(chargeCodes.code, code));
          if (!found) throw new UserFacingError(`Charge code "${code}" not found`);
          if (!found.chargeable) throw new UserFacingError(`${code} can't be charged right now.`);
          const [held] = await sp.select({ id: userChargeCodes.id }).from(userChargeCodes)
            .where(and(eq(userChargeCodes.userId, user.id), eq(userChargeCodes.chargeCodeId, found.id), eq(userChargeCodes.isActive, true)));
          if (held) return { skipped: SKIP_REASON.access };
          await assignChargeCodeToUserInternal(sp, actor.id, user.id, found.id);
          return { created: true };
        });
      }
      return throwIfDryRun(dryRun, byRow(result));
    }));
  });
}
