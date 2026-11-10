/**
 * The Setup checklist's steps (feature-plan-ux-setup-import.md P2): six required, in dependency order, then three
 * recommended. Client-safe — the server status (internal/setup.ts), the page and Home's card all key on these.
 */
export type SetupStepKey =
  | 'timeAndWeek' | 'paySchedule' | 'contractsClins' | 'chargeCodes' | 'people' | 'chargeCodeAccess'
  | 'indirectCodes' | 'laborCategories' | 'connection';

export const REQUIRED_SETUP_STEPS = 6;

export const SETUP_STEP_TITLE: Record<SetupStepKey, string> = {
  timeAndWeek: 'Time zone and workweek',
  paySchedule: 'Pay schedule',
  contractsClins: 'Contracts and CLINs',
  chargeCodes: 'Charge codes',
  people: 'People',
  chargeCodeAccess: 'Charge code access',
  indirectCodes: 'Indirect codes',
  laborCategories: 'Labor categories and rates',
  connection: 'Payroll or accounting connection',
};

export const SETUP_HREF = '/settings/setup';
