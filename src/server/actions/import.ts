'use server';

import { db } from '@/db';
import { users, contracts, clins, slins, laborCategories, userAssignments } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { requireAdmin } from '@/lib/session';
import bcrypt from 'bcryptjs';

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

export async function bulkImportEmployees(rows: EmployeeImportRow[]): Promise<ImportResult> {
  await requireAdmin();

  const result: ImportResult = { created: 0, skipped: 0, errors: [], generatedPasswords: [] };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const email = row.email.toLowerCase().trim();

      // Check if user already exists
      const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
      if (existing.length > 0) {
        result.skipped++;
        continue;
      }

      // Generate password
      const password = generateRandomPassword();
      const hash = await bcrypt.hash(password, 4); // Low cost for bulk

      const role = (['admin', 'supervisor', 'employee'].includes(row.role?.toLowerCase()))
        ? row.role.toLowerCase() as 'admin' | 'supervisor' | 'employee'
        : 'employee';

      await db.insert(users).values({
        email,
        fullName: row.name.trim(),
        role,
        passwordHash: hash,
        isActive: true,
        flsaExempt: row.flsaExempt?.toLowerCase() === 'yes' || row.flsaExempt?.toLowerCase() === 'true',
      });

      result.created++;
      result.generatedPasswords!.push({ email, password });
    } catch (error) {
      result.errors.push({ row: i + 1, message: String(error) });
    }
  }

  return result;
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

export async function bulkImportContracts(rows: ContractImportRow[]): Promise<ImportResult> {
  await requireAdmin();

  const result: ImportResult = { created: 0, skipped: 0, errors: [] };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const existing = await db.select({ id: contracts.id }).from(contracts)
        .where(eq(contracts.contractNumber, row.contractNumber.trim()));

      if (existing.length > 0) {
        result.skipped++;
        continue;
      }

      await db.insert(contracts).values({
        contractNumber: row.contractNumber.trim(),
        name: row.name.trim(),
        contractType: row.type?.toLowerCase() === 'sub' ? 'sub' : 'prime',
        fundedValue: row.fundedValue?.trim() || undefined,
        ceilingValue: row.ceilingValue?.trim() || undefined,
        startDate: row.startDate ? new Date(row.startDate) : undefined,
        endDate: row.endDate ? new Date(row.endDate) : undefined,
        status: 'active',
      });

      result.created++;
    } catch (error) {
      result.errors.push({ row: i + 1, message: String(error) });
    }
  }

  return result;
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

export async function bulkImportClins(rows: ClinImportRow[]): Promise<ImportResult> {
  await requireAdmin();

  const result: ImportResult = { created: 0, skipped: 0, errors: [] };

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
      result.errors.push({ row: i + 1, message: String(error) });
    }
  }

  return result;
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

export async function bulkImportLaborCategories(rows: LcatImportRow[]): Promise<ImportResult> {
  await requireAdmin();

  const result: ImportResult = { created: 0, skipped: 0, errors: [] };

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

      await db.insert(laborCategories).values({
        clinId: clin.id,
        lcatCode: row.lcatCode.trim(),
        title: row.title.trim(),
        hourlyRate: row.hourlyRate?.trim() || '0.00',
        ceilingRate: row.ceilingRate?.trim() || undefined,
        status: 'active',
      });

      result.created++;
    } catch (error) {
      result.errors.push({ row: i + 1, message: String(error) });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Bulk Assignment Import
// ---------------------------------------------------------------------------

export interface AssignmentImportRow {
  email: string;
  contractNumber: string;
  clinNumber: string;
}

export async function bulkImportAssignments(rows: AssignmentImportRow[]): Promise<ImportResult> {
  await requireAdmin();

  const result: ImportResult = { created: 0, skipped: 0, errors: [] };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      // Look up user
      const [user] = await db.select({ id: users.id }).from(users)
        .where(eq(users.email, row.email.toLowerCase().trim()));
      if (!user) {
        result.errors.push({ row: i + 1, message: `Employee "${row.email}" not found` });
        continue;
      }

      // Look up contract + CLIN
      const [contract] = await db.select({ id: contracts.id }).from(contracts)
        .where(eq(contracts.contractNumber, row.contractNumber.trim()));
      if (!contract) {
        result.errors.push({ row: i + 1, message: `Contract "${row.contractNumber}" not found` });
        continue;
      }

      const [clin] = await db.select({ id: clins.id }).from(clins)
        .where(and(eq(clins.contractId, contract.id), eq(clins.clinNumber, row.clinNumber.trim())));
      if (!clin) {
        result.errors.push({ row: i + 1, message: `CLIN "${row.clinNumber}" not found` });
        continue;
      }

      // Check for existing assignment
      const existing = await db.select({ id: userAssignments.id }).from(userAssignments)
        .where(and(eq(userAssignments.userId, user.id), eq(userAssignments.clinId, clin.id)));
      if (existing.length > 0) {
        result.skipped++;
        continue;
      }

      await db.insert(userAssignments).values({
        userId: user.id,
        clinId: clin.id,
        isActive: true,
      });

      result.created++;
    } catch (error) {
      result.errors.push({ row: i + 1, message: String(error) });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function generateRandomPassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$';
  let password = '';
  for (let i = 0; i < 12; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}
