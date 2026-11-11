// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';

/**
 * feature-plan-ux-setup-import.md §4, the rendered Import page (a few rows each — the pure rules are in
 * import-pipeline.test.ts):
 * IM-4/IM-16 (browser) skipped rows show their reason; the Import button counts only ready rows and sends only them,
 *       with their spreadsheet rows; "Nothing to import" when none are ready.
 * IM-11 (browser) changing the type while a check runs drops its late result.
 * IM-12 Hours: the window shows up front; closed → Import is aria-disabled with that reason and sends nothing.
 * IM-19 while importing, the type list and "Choose a different file" are aria-disabled with the reason; a People
 *       result's passwords arrive and their modal opens.
 * SU-12 the P15 pay-schedule notice shows on Hours when no schedule row exists (not otherwise, not on People).
 */

const deferredOf = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
const imports = vi.hoisted(() => ({
  bulkImportEmployees: vi.fn<(...a: unknown[]) => Promise<unknown>>(), bulkImportContracts: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  bulkImportClins: vi.fn(), bulkImportLaborCategories: vi.fn(), bulkImportChargeCodes: vi.fn(), bulkImportChargeCodeAccess: vi.fn(), bulkImportAssignments: vi.fn(),
}));
const migration = vi.hoisted(() => ({
  getImportWindowStatus: vi.fn<() => Promise<{ open: boolean | null }>>(async () => ({ open: true })),
  validateMigrationData: vi.fn(async (rows: unknown[]) => ({ ok: true, data: rows.map((data, i) => ({ rowIndex: i + 1, data, errors: [], isValid: true })) })),
  validateMigrationPeriods: vi.fn(), importMigrationData: vi.fn(), importMigrationPeriods: vi.fn(),
}));
vi.mock('@/server/actions/import', () => imports);
vi.mock('@/server/actions/migration', () => migration);
vi.mock('@/server/actions/setup', () => ({ getSetupPageData: vi.fn(async () => { throw new Error('kept as is'); }) }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

import { ImportClient } from '@/app/(app)/settings/import/ImportClient';
import { buttonByText, click, installDomStubs, mount, unmount, wait, type Mounted } from '../helpers/dom';
import { checkRow, checkRows, chooseFile, importPageData, typeButton } from '../helpers/import-page';

beforeAll(installDomStubs);
let m: Mounted | undefined;
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { unmount(m); m = undefined; });

const PEOPLE = 'Name,Email,Role,FLSA Exempt';
const HOURS = 'Employee Email,Entry Date,Contract Number,CLIN Number,Indirect Code,Hours';
const result = (o: Record<string, unknown> = {}) => ({ ok: true, data: { created: 0, skipped: 0, errors: [], skippedRows: [], ...o } });

describe('the Import page (§4)', () => {
  it('IM-4/IM-16: skipped rows show the reason; Import counts and sends only the ready rows, with their spreadsheet rows', async () => {
    imports.bulkImportEmployees
      .mockResolvedValueOnce(result({ skippedRows: [{ row: 3, reason: 'Already a user' }] }))
      .mockResolvedValueOnce(result({ created: 1, generatedPasswords: [{ email: 'cat@x.test', password: 'pw-1' }] }));
    m = await mount(<ImportClient initialData={importPageData()} initialType="people" />);
    await chooseFile(`${PEOPLE}\nBob,,Employee,No\nAnn,ann@x.test,Employee,No\nCat,cat@x.test,Employee,No\n`, 'people.csv');
    expect(imports.bulkImportEmployees).toHaveBeenNthCalledWith(1, [
      { row: 3, name: 'Ann', email: 'ann@x.test', role: 'Employee', flsaExempt: 'No' },
      { row: 4, name: 'Cat', email: 'cat@x.test', role: 'Employee', flsaExempt: 'No' },
    ], { dryRun: true });
    expect(checkRow(3).textContent).toContain('Will be skipped: Already a user');
    await click(buttonByText('Import 1 person'));
    await wait();
    expect(imports.bulkImportEmployees).toHaveBeenNthCalledWith(2, [{ row: 4, name: 'Cat', email: 'cat@x.test', role: 'Employee', flsaExempt: 'No' }], {});
    expect(document.body.querySelector('[data-testid="done-summary"]')!.textContent).toContain('1 imported · 0 skipped · 0 problems');
  });

  it('"Nothing to import" when no row is ready; the action isn\'t called', async () => {
    imports.bulkImportContracts.mockResolvedValueOnce(result({ errors: [{ row: 2, message: 'Type must be blank (prime), prime or sub.' }] }));
    m = await mount(<ImportClient initialData={importPageData()} initialType="contracts" />);
    await chooseFile('Contract Number,Name,Type\nK,One,joint\n', 'k.csv');
    await click(buttonByText('Import 0 contracts'));
    expect(document.body.querySelector('[role="alert"]')!.textContent).toBe('Nothing to import. Fix the rows with problems first.');
    expect(imports.bulkImportContracts).toHaveBeenCalledTimes(1);   // the check only
  });

  it('IM-11: changing the type while a check runs drops its late result', async () => {
    const pending = deferredOf<unknown>();
    imports.bulkImportEmployees.mockImplementationOnce(() => pending.promise);
    m = await mount(<ImportClient initialData={importPageData()} initialType="people" />);
    await chooseFile(`${PEOPLE}\nAnn,ann@x.test,Employee,No\n`, 'people.csv');
    expect(document.body.querySelector('[data-testid="checking"]')).not.toBeNull();
    window.history.replaceState({ __NA: true }, '');                                       // the router keeps its own state here
    const replace = vi.spyOn(window.history, 'replaceState');
    await click(typeButton('contracts'));
    // UX-4C2A-AUDIT.md F2: a null state, per the Next.js docs, so the router syncs the URL.
    expect(replace).toHaveBeenCalledWith(null, '', expect.objectContaining({ search: '?type=contracts' }));
    replace.mockRestore();
    await act(async () => { pending.resolve(result({ errors: [{ row: 2, message: 'stale' }] })); });
    await wait();
    expect(typeButton('contracts').getAttribute('aria-current')).toBe('true');
    expect(checkRows()).toHaveLength(0);
    expect(document.body.textContent).not.toContain('stale');
    expect(window.location.search).toBe('?type=contracts');
  });

  it('IM-19: while importing, the type list and the file are locked with the reason; the passwords arrive and their modal opens', async () => {
    const pending = deferredOf<unknown>();
    imports.bulkImportEmployees.mockResolvedValueOnce(result()).mockImplementationOnce(() => pending.promise);
    m = await mount(<ImportClient initialData={importPageData()} initialType="people" />);
    await chooseFile(`${PEOPLE}\nAnn,ann@x.test,Employee,No\n`, 'people.csv');
    await click(buttonByText('Import 1 person'));
    const contracts = typeButton('contracts');
    expect(contracts.getAttribute('aria-disabled')).toBe('true');
    expect(document.getElementById(contracts.getAttribute('aria-describedby')!)!.textContent).toBe('Wait for the import to finish.');
    expect(buttonByText('Choose a different file').getAttribute('aria-disabled')).toBe('true');
    await click(contracts);
    await click(buttonByText('Choose a different file'));
    expect(typeButton('people').getAttribute('aria-current')).toBe('true');
    await act(async () => { pending.resolve(result({ created: 1, generatedPasswords: [{ email: 'ann@x.test', password: 'Secret-1' }] })); });
    await wait();
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('ann@x.test');
    expect(dialog.textContent).toContain('Secret-1');
    expect(typeButton('contracts').getAttribute('aria-disabled')).toBeNull();
  });

  it('IM-12: Hours shows the window up front; closed → Import is aria-disabled with that reason and sends nothing', async () => {
    migration.getImportWindowStatus.mockResolvedValueOnce({ open: false });
    m = await mount(<ImportClient initialData={importPageData()} initialType="hours" />);
    await wait();
    const status = document.body.querySelector('[data-testid="import-window"]')!;
    expect(status.textContent).toContain('Import window: Closed — contact support to reopen it.');
    await chooseFile(`${HOURS}\na@x.test,2025-01-06,,,OH-001,8\n`, 'hours.csv');
    const button = buttonByText('Import 1 row of hours');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('aria-describedby')).toBe(status.id);
    await click(button);
    expect(migration.importMigrationData).not.toHaveBeenCalled();
  });

  it('SU-12: the pay-schedule notice shows on Hours when no schedule row exists — not when one does, not on People', async () => {
    m = await mount(<ImportClient initialData={importPageData({ payConfigSet: false })} initialType="hours" />);
    const notice = document.body.querySelector('[data-testid="pay-schedule-first"]')!;
    expect(notice.textContent).toContain('Confirm your pay schedule first. After hours are imported it can only change on a future date.');
    expect(notice.querySelector('a')!.getAttribute('href')).toBe('/settings/setup');
    await click(typeButton('people'));
    expect(document.body.querySelector('[data-testid="pay-schedule-first"]')).toBeNull();
    unmount(m);
    m = await mount(<ImportClient initialData={importPageData({ payConfigSet: true })} initialType="hours" />);
    expect(document.body.querySelector('[data-testid="pay-schedule-first"]')).toBeNull();
  });

  it('the type list: the order, a ✓ count where records exist, "New" on the two new types', async () => {
    m = await mount(<ImportClient initialData={importPageData({ counts: { employees: 7, contracts: 3 } })} initialType="people" />);
    const labels = [...document.body.querySelectorAll('[data-testid="import-types"] button')].map((b) => b.textContent);
    expect(labels).toEqual([
      '1People✓ 7 already', '2Contracts✓ 3 already', '3CLINs', '4Labor categories', '5Charge codesNew', '6Charge code accessNew', '7Approval scope',
      '8Hours', '9Timesheet status',
    ]);
  });
});

describe('fix round 1 (UX-4C2A-AUDIT.md F6)', () => {
  it('the window status that can\'t be read says so', async () => {
    migration.getImportWindowStatus.mockResolvedValueOnce({ open: null });
    m = await mount(<ImportClient initialData={importPageData()} initialType="timesheetStatus" />);
    await wait();
    expect(document.body.querySelector('[data-testid="import-window"]')!.textContent).toBe("Import window: Couldn't check whether past timesheets can be imported.");
  });
});

describe('UX-4C2A-AUDIT.md F7: the pay-schedule notice once hours exist', () => {
  it('no schedule row and timesheet data → the future-date wording, linking to Pay schedule', async () => {
    m = await mount(<ImportClient initialData={importPageData({ payConfigSet: false, hasTimesheetData: true })} initialType="hours" />);
    const notice = document.body.querySelector('[data-testid="pay-schedule-first"]')!;
    expect(notice.textContent).toContain('Hours are already imported, so the pay schedule can only change on a future date.');
    expect(notice.textContent).not.toContain('Confirm your pay schedule first');
    expect(notice.querySelector('a')!.getAttribute('href')).toBe('/settings/pay-schedule');
  });

  it('no schedule row and no timesheet data → still "Confirm your pay schedule first…"', async () => {
    m = await mount(<ImportClient initialData={importPageData({ payConfigSet: false, hasTimesheetData: false })} initialType="timesheetStatus" />);
    const notice = document.body.querySelector('[data-testid="pay-schedule-first"]')!;
    expect(notice.textContent).toContain('Confirm your pay schedule first. After hours are imported it can only change on a future date.');
    expect(notice.querySelector('a')!.getAttribute('href')).toBe('/settings/setup');
  });
});
