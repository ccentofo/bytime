// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';

/**
 * feature-plan-ux-page-fixes.md C10 / T-C10: Data import shows each row's errors as visible text in both wizards (no
 * title= tooltip), a role=status count, a list of rows with errors, and a red alert for missing required columns; a
 * server error is shown at its FILE row (the server numbers the valid rows it was sent), from a snapshot taken when
 * Import was clicked, so choosing another file mid-import doesn't remap it.
 */

const actions = vi.hoisted(() => {
  const ok = async () => ({ ok: true, data: { created: 0, skipped: 0, errors: [] } });
  return {
    bulkImportEmployees: vi.fn<(...a: unknown[]) => Promise<unknown>>(ok),
    bulkImportContracts: vi.fn<(...a: unknown[]) => Promise<unknown>>(ok),
    bulkImportClins: vi.fn(ok), bulkImportLaborCategories: vi.fn(ok), bulkImportAssignments: vi.fn(ok),
  };
});
vi.mock('@/server/actions/import', () => actions);
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

import { ImportClient } from '@/app/(app)/settings/import/ImportClient';
import { buttonByText, click, installDomStubs, mount, unmount, wait, type Mounted } from '../helpers/dom';

beforeAll(installDomStubs);
let m: Mounted | undefined;
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { unmount(m); m = undefined; });

const panel = () => m!.container.querySelector('[role="tabpanel"]:not([style*="display: none"])') as HTMLElement;
async function upload(text: string, name = 'people.csv') {
  const input = panel().querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [new File([text], name, { type: 'text/csv' })], configurable: true });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
  await wait(50);                                                      // FileReader is asynchronous
}
const status = () => panel().querySelector('[role="status"]')?.textContent;
const row = (n: number) => [...panel().querySelectorAll('tbody tr')].find((tr) => tr.querySelector('td')?.textContent === String(n)) as HTMLElement;
const HEADER = 'Name,Email,Role,FLSA Exempt';

describe('Data import row errors (C10, T-C10)', () => {
  it('employees: errors are visible text in the status cell (no title=), with the count and the list of rows with errors', async () => {
    m = await mount(<ImportClient />);
    await upload(`${HEADER}\nAnn,ann@x.test,employee,false\nBob,,employee,false\nCat,cat@x.test,employee,true\n`);
    expect(status()).toBe('2 rows ready to import. 1 row has errors. Fix them in your file and upload it again.');
    const cell = row(2).querySelectorAll('td')[1];
    expect(cell.textContent).toContain('Error');
    expect(cell.textContent).toContain('Email is required');
    expect(panel().querySelector('[title]')).toBeNull();
    expect(panel().textContent).toContain('Rows with errors (1)');
    expect(panel().textContent).toContain('Row 1 is the first row after the header. Blank lines aren\'t counted.');
    expect([...panel().querySelectorAll('li')].map((li) => li.textContent)).toEqual(['Row 2: Email is required']);
  });

  it('no errors → only the first sentence; a file missing required columns → the red alert', async () => {
    m = await mount(<ImportClient />);
    await upload(`${HEADER}\nAnn,ann@x.test,employee,false\n`);
    expect(status()).toBe('1 row ready to import.');
    expect(panel().querySelector('[role="alert"]')).toBeNull();
    await upload('Name,Email\nAnn,ann@x.test\n');
    expect(panel().querySelector('[role="alert"]')!.textContent).toBe('This file is missing required columns: Role, FLSA Exempt. Download the template to see the expected headers.');
  });

  it('more than 100 rows with errors → 100 listed, then "…and k more"', async () => {
    m = await mount(<ImportClient />);
    await upload(`${HEADER}\n${Array.from({ length: 103 }, (_, i) => `P${i},,employee,false`).join('\n')}\n`);
    expect(panel().querySelectorAll('li')).toHaveLength(100);
    expect(panel().textContent).toContain('…and 3 more');
  });

  it('another tab (contracts) shows row errors as visible text too', async () => {
    m = await mount(<ImportClient />);
    await click([...m.container.querySelectorAll('[role="tab"]')].find((t) => t.textContent === 'Contracts'));
    await upload('Contract Number,Name,Type,Funded Value,Ceiling Value,Start Date,End Date\nC-1,,FFP,1,2,2026-01-01,2026-12-31\n', 'contracts.csv');
    expect(row(1).querySelectorAll('td')[1].textContent).toContain('Name is required');
    expect(panel().querySelector('[title]')).toBeNull();
  });

  it('a server error on the first valid row is shown at its file row (employees and another wizard)', async () => {
    actions.bulkImportEmployees.mockResolvedValueOnce({ ok: true, data: { created: 1, skipped: 0, errors: [{ row: 1, message: 'That employee already exists.' }], generatedPasswords: [] } });
    m = await mount(<ImportClient />);
    await upload(`${HEADER}\nBad,,employee,false\nAnn,ann@x.test,employee,false\nCat,cat@x.test,employee,true\n`);
    await click(buttonByText('Import 2 Employees'));
    await wait();
    expect(panel().textContent).toContain('Row 2: That employee already exists.');

    actions.bulkImportContracts.mockResolvedValueOnce({ ok: true, data: { created: 0, skipped: 0, errors: [{ row: 2, message: 'That contract already exists.' }] } });
    await click([...m.container.querySelectorAll('[role="tab"]')].find((t) => t.textContent === 'Contracts'));
    await upload('Contract Number,Name,Type,Funded Value,Ceiling Value,Start Date,End Date\nC-1,One,FFP,1,2,2026-01-01,2026-12-31\nC-2,,FFP,1,2,2026-01-01,2026-12-31\nC-3,Three,FFP,1,2,2026-01-01,2026-12-31\n', 'contracts.csv');
    await click(buttonByText('Import 2 Valid Rows'));
    await wait();
    expect(panel().textContent).toContain('Row 3: That contract already exists.');
  });

  it('choosing another file while the import runs doesn\'t remap its errors', async () => {
    let resolve!: (v: unknown) => void;
    actions.bulkImportEmployees.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    m = await mount(<ImportClient />);
    await upload(`${HEADER}\nBad,,employee,false\nAnn,ann@x.test,employee,false\n`);
    await click(buttonByText('Import 1 Employee'));
    await upload(`${HEADER}\nZed,zed@x.test,employee,false\n`, 'other.csv');   // the new file's first valid row is row 1
    await act(async () => { resolve({ ok: true, data: { created: 0, skipped: 0, errors: [{ row: 1, message: 'That employee already exists.' }] } }); });
    await wait();
    expect(panel().textContent).toContain('Row 2: That employee already exists.');
    expect(panel().textContent).not.toContain('Row 1: That employee already exists.');
  });
});
