import 'server-only';
import { eq } from 'drizzle-orm';
import type { DbTx, ReadDb } from '@/db';
import { contracts } from '@/db/schema';
import { UserFacingError } from '@/lib/errors';
import {
  validateClinNumber, validateContractNumber, validateMonetaryValue, validateOptionalCalendarDate, validateOptionalString, validateRate,
  validateRequired, validateStringLength,
} from '@/lib/validation';
import type { CalendarDate } from '@/lib/calendar-date';

/**
 * The create actions' validation, extracted so the setup imports apply exactly the same rules
 * (feature-plan-ux-setup-import.md §4.3): createContract / createClin / createLaborCategory and the imports both call
 * these. INTERNAL (no guard — callers are guarded actions).
 */

const CONTRACT_TYPES = ['prime', 'sub'] as const;

export function validateContractType(value: unknown): (typeof CONTRACT_TYPES)[number] {
  if (!(CONTRACT_TYPES as readonly unknown[]).includes(value)) throw new UserFacingError('Invalid contract type.');
  return value as (typeof CONTRACT_TYPES)[number];
}

/** From createContract (contracts.ts): number, name, description, type, dates, money. */
export function validateContractInput(data: {
  contractNumber: unknown; name: unknown; description?: unknown; contractType?: unknown;
  startDate?: unknown; endDate?: unknown; fundedValue?: unknown; ceilingValue?: unknown;
}) {
  return {
    contractNumber: validateContractNumber(data.contractNumber),
    name: validateStringLength(validateRequired(data.name, 'Contract name'), 'Contract name', 1, 255),
    description: validateOptionalString(data.description, 'Description', 2000),
    contractType: validateContractType(data.contractType ?? 'prime'),
    startDate: validateOptionalCalendarDate(data.startDate as CalendarDate | undefined, 'Start date'),
    endDate: validateOptionalCalendarDate(data.endDate as CalendarDate | undefined, 'End date'),
    fundedValue: validateMonetaryValue(data.fundedValue, 'Funded value'),
    ceilingValue: validateMonetaryValue(data.ceilingValue, 'Ceiling value'),
  };
}

/** From createClin (clins.ts): the contract exists and is ACTIVE (C3: a closed contract takes no new CLINs), number, money. */
export async function validateClinInput(db: Pick<ReadDb, 'select'> | Pick<DbTx, 'select'>, data: {
  contractId: string; clinNumber: unknown; description?: unknown; fundedAmount?: unknown;
}) {
  const [parent] = await (db as Pick<ReadDb, 'select'>).select({ status: contracts.status }).from(contracts).where(eq(contracts.id, data.contractId));
  if (!parent) throw new UserFacingError('That contract no longer exists.', 'not_found');
  if (parent.status !== 'active') throw new UserFacingError("This contract isn't active. Reopen it before adding CLINs.");
  return {
    contractId: data.contractId,
    clinNumber: validateClinNumber(data.clinNumber),
    description: validateOptionalString(data.description, 'Description', 2000),
    fundedAmount: validateMonetaryValue(data.fundedAmount, 'Funded amount'),
  };
}

/** From createLaborCategory (labor-categories.ts): code and title lengths, rates through validateRate. */
export function validateLaborCategoryInput(data: { lcatCode: unknown; title: unknown; hourlyRate: unknown; ceilingRate?: unknown }) {
  return {
    lcatCode: validateStringLength(validateRequired(data.lcatCode, 'LCAT code'), 'LCAT code', 1, 50),
    title: validateStringLength(validateRequired(data.title, 'Title'), 'Title', 1, 255),
    hourlyRate: validateRate(data.hourlyRate, 'Hourly rate'),
    ceilingRate: data.ceilingRate ? validateRate(data.ceilingRate, 'Ceiling rate') : undefined,
  };
}
