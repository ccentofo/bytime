import { act } from 'react';
import type { SetupPageData } from '@/server/internal/setup';
import { wait } from './dom';

/** The Import page's tests (feature-plan-ux-setup-import.md §4): page data, and choosing a file in its FileInput. */

export function importPageData(o: { payConfigSet?: boolean; counts?: Partial<SetupPageData['status']['counts']>; scopeCount?: number } = {}): SetupPageData {
  const counts = { indirectCodes: 0, contracts: 0, clins: 0, chargeCodes: 0, laborCategories: 0, employees: 0, employeesWithAccess: 0, adminsWithAccess: 0, clinsWithoutCode: 0, ...o.counts };
  const keys = ['timeAndWeek', 'paySchedule', 'contractsClins', 'chargeCodes', 'people', 'chargeCodeAccess', 'indirectCodes', 'laborCategories', 'connection'] as const;
  return {
    status: {
      steps: keys.map((key, i) => ({ key, required: i < 6, done: false, ...(key === 'chargeCodeAccess' ? { withAccess: counts.employeesWithAccess, total: counts.employees } : {}) })),
      requiredDone: 0, requiredTotal: 6, isComplete: false, counts, hasTimesheetData: false, payConfigSet: o.payConfigSet ?? true,
    },
    gaps: { missingCount: 0, names: [] },
    settings: { timezone: 'America/New_York', workweekStartDay: null, payConfig: { set: o.payConfigSet ?? true, periodType: 'semimonthly', anchorDate: '2026-01-01', weekStartDay: 1 }, connectionName: null },
    scopeCount: o.scopeCount ?? 0,
  };
}

/** Choose a file in the page's FileInput (Mantine renders the hidden input just before its wrapper); FileReader is async. */
export async function chooseFile(text: string, name = 'file.csv'): Promise<void> {
  const input = document.body.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [new File([text], name, { type: 'text/csv' })], configurable: true });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
  await wait(40);
}

export const checkRows = () => [...document.body.querySelectorAll('[data-testid="check-table"] tbody tr')] as HTMLElement[];
export const checkRow = (n: number) => checkRows().find((tr) => tr.querySelector('td')?.textContent === String(n)) as HTMLElement;
export const typeButton = (key: string) => document.body.querySelector(`[data-testid="import-types"] [data-type="${key}"]`) as HTMLButtonElement;
