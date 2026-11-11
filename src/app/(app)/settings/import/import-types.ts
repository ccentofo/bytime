import type { SetupImportType } from '@/lib/import/limits';
import type { SetupPageData } from '@/server/internal/setup';

/**
 * The Import page's nine types (feature-plan-ux-setup-import.md P8, §4.1, §4.5). Pure, client-safe. A setup type's
 * columns map spreadsheet headers to the action's fields; required columns must be present and filled, optional ones
 * may be missing or blank (P12).
 */

export type HistoryImportType = 'hours' | 'timesheetStatus';
export type ImportTypeKey = SetupImportType | HistoryImportType;

export interface ImportColumn { header: string; field: string }

interface TypeBase {
  n: number;
  label: string;
  /** [one, many]: "Import 3 {many}". */
  noun: readonly [string, string];
  template: string;
  /** One line under the title: what the type does and what must exist first. */
  note: string;
}

export interface SetupTypeDef extends TypeBase {
  kind: 'setup';
  key: SetupImportType;
  required: ImportColumn[];
  optional: ImportColumn[];
  /** The check table's identifying columns. */
  keyColumns: Array<{ header: string; value: (d: Record<string, string>) => string }>;
}

export interface HistoryTypeDef extends TypeBase {
  kind: 'history';
  key: HistoryImportType;
  /** Must be in the header; may be blank in a row (§4.4). */
  headerColumns: string[];
  optional: string[];
}

export type ImportTypeDef = SetupTypeDef | HistoryTypeDef;

const col = (header: string, field: string): ImportColumn => ({ header, field });
const contractClin = { header: 'Contract · CLIN', value: (d: Record<string, string>) => [d['Contract Number'], d['CLIN Number']].filter(Boolean).join(' · ') };

export const SETUP_TYPES: SetupTypeDef[] = [
  {
    kind: 'setup', key: 'people', n: 1, label: 'People', noun: ['person', 'people'], template: 'employee-import-template.csv',
    note: 'Creates accounts with a generated password, shown once after the import.',
    required: [col('Name', 'name'), col('Email', 'email'), col('Role', 'role'), col('FLSA Exempt', 'flsaExempt')],
    optional: [],
    keyColumns: [{ header: 'Name', value: (d) => d['Name'] ?? '' }, { header: 'Email', value: (d) => d['Email'] ?? '' }],
  },
  {
    kind: 'setup', key: 'contracts', n: 2, label: 'Contracts', noun: ['contract', 'contracts'], template: 'contract-import-template.csv',
    note: 'Type is prime (or blank) or sub. Money is a plain number, like 1250000.00.',
    required: [col('Contract Number', 'contractNumber'), col('Name', 'name')],
    optional: [col('Type', 'type'), col('Funded Value', 'fundedValue'), col('Ceiling Value', 'ceilingValue'), col('Start Date', 'startDate'), col('End Date', 'endDate')],
    keyColumns: [{ header: 'Contract number', value: (d) => d['Contract Number'] ?? '' }, { header: 'Name', value: (d) => d['Name'] ?? '' }],
  },
  {
    kind: 'setup', key: 'clins', n: 3, label: 'CLINs', noun: ['CLIN', 'CLINs'], template: 'clin-import-template.csv',
    note: 'Import the contracts first. A CLIN goes on an active contract.',
    required: [col('Contract Number', 'contractNumber'), col('CLIN Number', 'clinNumber')],
    optional: [col('Description', 'description'), col('Funded Amount', 'fundedAmount')],
    keyColumns: [contractClin],
  },
  {
    kind: 'setup', key: 'laborCategories', n: 4, label: 'Labor categories', noun: ['labor category', 'labor categories'], template: 'labor-category-import-template.csv',
    note: 'Import the CLINs first. Rates are plain numbers, like 145.00.',
    required: [col('Contract Number', 'contractNumber'), col('CLIN Number', 'clinNumber'), col('LCAT Code', 'lcatCode'), col('Title', 'title'), col('Hourly Rate', 'hourlyRate')],
    optional: [col('Ceiling Rate', 'ceilingRate')],
    keyColumns: [contractClin, { header: 'LCAT code', value: (d) => d['LCAT Code'] ?? '' }],
  },
  {
    kind: 'setup', key: 'chargeCodes', n: 5, label: 'Charge codes', noun: ['charge code', 'charge codes'], template: 'charge-code-import-template.csv',
    note: 'Import the CLINs (and any labor categories) first. Location is onsite, telework or other; Billable is Yes or No.',
    required: [col('Code', 'code'), col('Name', 'name'), col('Contract Number', 'contractNumber'), col('CLIN Number', 'clinNumber')],
    optional: [col('SLIN Number', 'slinNumber'), col('Labor Category', 'laborCategory'), col('Location', 'location'), col('Billable', 'billable'), col('Description', 'description')],
    keyColumns: [{ header: 'Code', value: (d) => d['Code'] ?? '' }, contractClin],
  },
  {
    kind: 'setup', key: 'chargeCodeAccess', n: 6, label: 'Charge code access', noun: ['access grant', 'access grants'], template: 'charge-code-access-import-template.csv',
    note: 'Each row lets one person charge one code. Import the people and the charge codes first.',
    required: [col('Email', 'email'), col('Charge Code', 'chargeCode')],
    optional: [],
    keyColumns: [{ header: 'Email', value: (d) => d['Email'] ?? '' }, { header: 'Charge code', value: (d) => d['Charge Code'] ?? '' }],
  },
  {
    kind: 'setup', key: 'approvalScope', n: 7, label: 'Approval scope', noun: ['approval scope', 'approval scopes'], template: 'assignment-import-template.csv',
    note: 'Give supervisors approval scope on CLINs. Each row lets one supervisor approve employees on one CLIN. The supervisors must already exist (import People first, with the supervisor role), and so must the contracts and CLINs.',
    required: [col('Email', 'email'), col('Contract Number', 'contractNumber'), col('CLIN Number', 'clinNumber')],
    optional: [],
    keyColumns: [{ header: 'Email', value: (d) => d['Email'] ?? '' }, contractClin],
  },
];

export const HISTORY_TYPES: HistoryTypeDef[] = [
  {
    kind: 'history', key: 'hours', n: 8, label: 'Hours', noun: ['row of hours', 'rows of hours'], template: 'migration-timesheet-template.csv',
    note: 'Each row is one day of hours on a contract CLIN or an indirect code. Import hours before timesheet status.',
    headerColumns: ['Employee Email', 'Entry Date', 'Contract Number', 'CLIN Number', 'Indirect Code', 'Hours'],
    optional: ['Change Reason', 'Comment', 'Created At', 'Entered By'],
  },
  {
    kind: 'history', key: 'timesheetStatus', n: 9, label: 'Timesheet status', noun: ['timesheet status', 'timesheet statuses'], template: 'migration-periods-template.csv',
    note: 'Only submitted, approved or returned periods that ended before today are imported.',
    headerColumns: ['Employee Email', 'Period Start', 'Status'],
    optional: ['Submitted At', 'Reviewed At', 'Reviewed By Email', 'Review Comment'],   // the server treats Submitted At as optional (UX-4C2A-AUDIT.md F3)
  },
];

export const ALL_TYPES: ImportTypeDef[] = [...SETUP_TYPES, ...HISTORY_TYPES];

/** `?type=`: a known key, else People (§4.1). */
export function importTypeFrom(value: string | null | undefined): ImportTypeKey {
  return (ALL_TYPES.find((t) => t.key === value)?.key ?? 'people');
}

export const typeDef = (key: ImportTypeKey): ImportTypeDef => ALL_TYPES.find((t) => t.key === key)!;

export const nounFor = (def: ImportTypeDef, n: number) => (n === 1 ? def.noun[0] : def.noun[1]);

/** The ✓ count of existing records per setup type (§4.1); null when there's nothing to show. */
export function existingCount(key: ImportTypeKey, data: SetupPageData): number | null {
  const c = data.status.counts;
  const access = data.status.steps.find((s) => s.key === 'chargeCodeAccess');
  switch (key) {
    case 'people': return c.employees + c.adminsWithAccess;
    case 'contracts': return c.contracts;
    case 'clins': return c.clins;
    case 'laborCategories': return c.laborCategories;
    case 'chargeCodes': return c.chargeCodes;
    case 'chargeCodeAccess': return access?.withAccess ?? 0;
    case 'approvalScope': return data.scopeCount;
    default: return null;
  }
}

/** Types 5 and 6 are new: "New" until they have records. */
export const isNewType = (key: ImportTypeKey) => key === 'chargeCodes' || key === 'chargeCodeAccess';
