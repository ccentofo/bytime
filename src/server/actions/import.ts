'use server';

import { getDbForWrite } from '@/db';
import { users, contracts, clins, slins, laborCategories } from '@/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { requireAdminFresh } from '@/lib/session';
import { assertSeatsAvailable } from '@/server/internal/seats';
import { loadApprovalFacts, lockUserRulesExclusive, newlyEligible, recomputeSelfApproval, scopeChange, snapshotSubmittedEligibility } from '@/server/internal/approval-rules';
import { grantScopeRows } from '@/server/internal/approval-scopes';
import { UserFacingError } from '@/lib/errors';
import { generateImportPassword } from '@/server/internal/generated-password';
import { notifyReroutedApprovals } from '@/server/internal/submission-notify';
import bcrypt from 'bcryptjs';
import { importRowMessage, parseImportDate } from '@/server/internal/import-errors';
import { userAction, type ActionResult } from '@/lib/action-result';
import { validateRate } from '@/lib/validation';
import { logAdminChange } from '@/server/internal/admin-change-log';

// ---------------------------------------------------------------------------
// Bulk Employee Import
// ---------------------------------------------------------------------------

export interface EmployeeImportRow {
  name: string;
  email: string;
  role: string;
  flsaExempt: string;
}

export interface ImportResult {
  created: number;
  skipped: number;
  errors: { row: number; message: string }[];
  generatedPasswords?: { email: string; password: string }[];
}

export async function bulkImportEmployees(rows: EmployeeImportRow[]): Promise<ActionResult<ImportResult>> {
  return userAction(async () => {
    const actor = await requireAdminFresh();
    const db = await getDbForWrite();

    // R2-11: count genuinely NEW rows (excluding ones matching an existing user by email) and
    // reject the WHOLE batch up front if it would exceed the plan's seat limit. Previously only
    // single-user creation paths (createUser/createUserWithPassword) checked this, so a bulk
    // import could blow straight past the limit in one request.
    // Distinct, well-formed emails only: a row with a missing email is reported by the per-row
    // loop below, and a repeated email only ever creates one user.
    const incomingEmails = [...new Set(
      rows.map((row) => (typeof row.email === 'string' ? row.email.toLowerCase().trim() : '')).filter(Boolean)
    )];
    // certified-outputs C2 (CO-D19, ruling Q5): one transaction with the self-approval recompute and the re-routing
    // snapshot. Each row runs in its own savepoint, so a failing row is reported and the others still import.
    const { result, rerouted } = await db.transaction(async (tx) => {
      await lockUserRulesExclusive(tx); // F1: first statement, before any row lock
      const existingRows = incomingEmails.length > 0
        ? await tx.select({ email: users.email }).from(users).where(inArray(users.email, incomingEmails))
        : [];
      const existingEmails = new Set(existingRows.map((r) => r.email.toLowerCase()));
      const newRowCount = incomingEmails.filter((email) => !existingEmails.has(email)).length;
      if (newRowCount > 0) {
        await assertSeatsAvailable(newRowCount, tx);
      }

      const result: ImportResult = { created: 0, skipped: 0, errors: [], generatedPasswords: [] };
      const beforeFacts = await loadApprovalFacts(tx);
      const before = await snapshotSubmittedEligibility(tx, beforeFacts);

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        try {
          const email = row.email.toLowerCase().trim();

          // Check if user already exists
          const existing = await tx.select({ id: users.id }).from(users).where(eq(users.email, email));
          if (existing.length > 0) {
            result.skipped++;
            continue;
          }

          // Generate password
          const password = generateImportPassword();
          const hash = await bcrypt.hash(password, 4); // Low cost for bulk

          const role = (['admin', 'supervisor', 'employee'].includes(row.role?.toLowerCase()))
            ? row.role.toLowerCase() as 'admin' | 'supervisor' | 'employee'
            : 'employee';

          const flsaExempt = row.flsaExempt?.toLowerCase() === 'yes' || row.flsaExempt?.toLowerCase() === 'true';
          await tx.transaction(async (sp) => {
            const [created] = await sp.insert(users).values({
              email,
              fullName: row.name.trim(),
              role,
              passwordHash: hash,
              isActive: true,
              flsaExempt,
            }).returning({ id: users.id });
            // feature-plan-ux-people-codes.md R5: logged in the row's own savepoint (a failed row logs nothing).
            await logAdminChange(sp, { actorId: actor.id, entity: 'user', entityId: created.id, action: 'created', oldValue: null, newValue: { role, flsaExempt } });
          });

          result.created++;
          result.generatedPasswords!.push({ email, password });
        } catch (error) {
          result.errors.push({ row: i + 1, message: importRowMessage(error, 'That employee already exists.') });
        }
      }

      if (result.created > 0) await recomputeSelfApproval(tx, actor.id, `${result.created} user(s) imported`, { before: beforeFacts });
      return { result, rerouted: result.created > 0 ? newlyEligible(before, await snapshotSubmittedEligibility(tx)) : [] };
    });
    await notifyReroutedApprovals(rerouted);

    return result;
  });
}

// ---------------------------------------------------------------------------
// Bulk Contract Import
// ---------------------------------------------------------------------------

export interface ContractImportRow {
  contractNumber: string;
  name: string;
  type: string;
  fundedValue: string;
  ceilingValue: string;
  startDate: string;
  endDate: string;
}

export async function bulkImportContracts(rows: ContractImportRow[]): Promise<ActionResult<ImportResult>> {
  return userAction(async () => {
    await requireAdminFresh();

    const result: ImportResult = { created: 0, skipped: 0, errors: [] };

    const db = await getDbForWrite();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        const existing = await db.select({ id: contracts.id }).from(contracts)
          .where(eq(contracts.contractNumber, row.contractNumber.trim()));

        if (existing.length > 0) {
          result.skipped++;
          continue;
        }

        const trimmedStart = row.startDate?.trim();
        const trimmedEnd = row.endDate?.trim();
        await db.insert(contracts).values({
          contractNumber: row.contractNumber.trim(),
          name: row.name.trim(),
          contractType: row.type?.toLowerCase() === 'sub' ? 'sub' : 'prime',
          fundedValue: row.fundedValue?.trim() || undefined,
          ceilingValue: row.ceilingValue?.trim() || undefined,
          startDate: trimmedStart ? parseImportDate(trimmedStart, 'Start date') : undefined,
          endDate: trimmedEnd ? parseImportDate(trimmedEnd, 'End date') : undefined,
          status: 'active',
        });

        result.created++;
      } catch (error) {
        result.errors.push({ row: i + 1, message: importRowMessage(error, 'That contract already exists.') });
      }
    }

    return result;
  });
}

// ---------------------------------------------------------------------------
// Bulk CLIN Import
// ---------------------------------------------------------------------------

export interface ClinImportRow {
  contractNumber: string;
  clinNumber: string;
  description: string;
  fundedAmount: string;
}

export async function bulkImportClins(rows: ClinImportRow[]): Promise<ActionResult<ImportResult>> {
  return userAction(async () => {
    await requireAdminFresh();

    const result: ImportResult = { created: 0, skipped: 0, errors: [] };

    const db = await getDbForWrite();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        // Look up contract by number
        const [contract] = await db.select({ id: contracts.id }).from(contracts)
          .where(eq(contracts.contractNumber, row.contractNumber.trim()));

        if (!contract) {
          result.errors.push({ row: i + 1, message: `Contract "${row.contractNumber}" not found` });
          continue;
        }

        await db.insert(clins).values({
          contractId: contract.id,
          clinNumber: row.clinNumber.trim(),
          description: row.description?.trim() || undefined,
          fundedAmount: row.fundedAmount?.trim() || undefined,
          status: 'active',
        });

        result.created++;
      } catch (error) {
        result.errors.push({ row: i + 1, message: importRowMessage(error, 'That CLIN already exists under this contract.') });
      }
    }

    return result;
  });
}

// ---------------------------------------------------------------------------
// Bulk Labor Category Import
// ---------------------------------------------------------------------------

export interface LcatImportRow {
  contractNumber: string;
  clinNumber: string;
  lcatCode: string;
  title: string;
  hourlyRate: string;
  ceilingRate: string;
}

export async function bulkImportLaborCategories(rows: LcatImportRow[]): Promise<ActionResult<ImportResult>> {
  return userAction(async () => {
    await requireAdminFresh();

    const result: ImportResult = { created: 0, skipped: 0, errors: [] };

    const db = await getDbForWrite();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        // Look up contract
        const [contract] = await db.select({ id: contracts.id }).from(contracts)
          .where(eq(contracts.contractNumber, row.contractNumber.trim()));
        if (!contract) {
          result.errors.push({ row: i + 1, message: `Contract "${row.contractNumber}" not found` });
          continue;
        }

        // Look up CLIN
        const [clin] = await db.select({ id: clins.id }).from(clins)
          .where(and(eq(clins.contractId, contract.id), eq(clins.clinNumber, row.clinNumber.trim())));
        if (!clin) {
          result.errors.push({ row: i + 1, message: `CLIN "${row.clinNumber}" not found under contract "${row.contractNumber}"` });
          continue;
        }

        // Dated rates D1.6: the starting rate goes through validateRate (a blank or '$145' hourly rate is a row error —
        // an unparseable stored rate would make every pricing query fail on its cast); a blank ceiling is none.
        const hourlyRate = validateRate(row.hourlyRate, 'Hourly rate');
        const ceilingRate = typeof row.ceilingRate === 'string' && row.ceilingRate.trim() !== '' ? validateRate(row.ceilingRate, 'Ceiling rate') : undefined;

        await db.insert(laborCategories).values({
          clinId: clin.id,
          lcatCode: row.lcatCode.trim(),
          title: row.title.trim(),
          hourlyRate,
          ceilingRate,
          status: 'active',
        });

        result.created++;
      } catch (error) {
        result.errors.push({ row: i + 1, message: importRowMessage(error, 'That labor category already exists on this CLIN.') });
      }
    }

    return result;
  });
}

// ---------------------------------------------------------------------------
// Bulk Approval-Scope Import (the "assignments" tab)
// ---------------------------------------------------------------------------

const MAX_ASSIGNMENT_ROWS = 500;

export interface AssignmentImportRow {
  email: string;
  contractNumber: string;
  clinNumber: string;
}

/**
 * The import's approval-scope tab (feature-plan-approval-scope.md S7, §4.2): each row lets one supervisor approve
 * employees on one CLIN. Up to 500 rows under ONE scopeChange (the user-rules lock first; waiting timesheets re-route
 * once); each row runs in its own savepoint, so a bad row (unknown user, not an active supervisor, unknown or inactive
 * CLIN, or a database error) is reported and the others still import. An already-active scope is skipped.
 */
export async function bulkImportAssignments(rows: AssignmentImportRow[]): Promise<ActionResult<ImportResult>> {
  return userAction(async () => {
    const actor = await requireAdminFresh();
    if (!Array.isArray(rows)) throw new UserFacingError('Nothing to import.');
    if (rows.length > MAX_ASSIGNMENT_ROWS) throw new UserFacingError('Import 500 rows or fewer at a time.');
    const db = await getDbForWrite();
    const { result, rerouted } = await scopeChange(db, async (tx) => {
      const result: ImportResult = { created: 0, skipped: 0, errors: [] };
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        try {
          const outcome = await tx.transaction(async (sp) => {
            const email = String(row.email ?? '').toLowerCase().trim();
            const contractNumber = String(row.contractNumber ?? '').trim();
            const clinNumber = String(row.clinNumber ?? '').trim();
            const [user] = await sp.select({ id: users.id, role: users.role, isActive: users.isActive }).from(users).where(eq(users.email, email));
            if (!user) throw new UserFacingError(`User "${row.email}" not found`);
            if (!user.isActive || user.role !== 'supervisor') throw new UserFacingError(`${row.email} isn't an active supervisor, so they can't approve a CLIN.`);
            const [clin] = await sp.select({ id: clins.id, status: clins.status, contractStatus: contracts.status })
              .from(clins).innerJoin(contracts, eq(clins.contractId, contracts.id))
              .where(and(eq(contracts.contractNumber, contractNumber), eq(clins.clinNumber, clinNumber)));
            if (!clin) throw new UserFacingError(`CLIN "${row.clinNumber}" not found under contract "${row.contractNumber}"`);
            if (clin.status !== 'active' || clin.contractStatus !== 'active') throw new UserFacingError(`CLIN "${row.clinNumber}" under contract "${row.contractNumber}" isn't active.`);
            const granted = await grantScopeRows(sp, { actorId: actor.id, supervisorId: user.id, clinIds: [clin.id], source: 'import' });
            return granted.length > 0 ? 'created' : 'skipped';
          });
          result[outcome]++;
        } catch (error) {
          result.errors.push({ row: i + 1, message: importRowMessage(error, 'That approval scope already exists.') });
        }
      }
      return result;
    });
    await notifyReroutedApprovals(rerouted);
    return result;
  });
}
