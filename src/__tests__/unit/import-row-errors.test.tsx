// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

/**
 * feature-plan-ux-page-fixes.md C10, carried onto the rebuilt Import page (feature-plan-ux-setup-import.md §4.2): each
 * row's problem is visible text in the check table (no title= tooltip), the summary is a role=status line, a file
 * missing required columns is refused at the file input with the missing names, and a problem the server check reports
 * is shown at its spreadsheet row (P11: the server echoes the row the browser sent).
 */

const actions = vi.hoisted(() => {
  const ok = async () => ({ ok: true, data: { created: 0, skipped: 0, errors: [], skippedRows: [] } });
  return {
    bulkImportEmployees: vi.fn<(...a: unknown[]) => Promise<unknown>>(ok), bulkImportContracts: vi.fn<(...a: unknown[]) => Promise<unknown>>(ok),
    bulkImportClins: vi.fn(ok), bulkImportLaborCategories: vi.fn(ok), bulkImportChargeCodes: vi.fn(ok), bulkImportChargeCodeAccess: vi.fn(ok),
    bulkImportAssignments: vi.fn(ok),
  };
});
vi.mock('@/server/actions/import', () => actions);
vi.mock('@/server/actions/setup', () => ({ getSetupPageData: vi.fn(async () => { throw new Error('not needed'); }) }));
vi.mock('@/server/actions/migration', () => ({ getImportWindowStatus: vi.fn(async () => ({ open: true })) }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

import { ImportClient } from '@/app/(app)/settings/import/ImportClient';
import { installDomStubs, mount, unmount, type Mounted } from '../helpers/dom';
import { checkRow, chooseFile, importPageData } from '../helpers/import-page';

beforeAll(installDomStubs);
let m: Mounted | undefined;
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { unmount(m); m = undefined; });

const HEADER = 'Name,Email,Role,FLSA Exempt';
const summary = () => document.body.querySelector('[data-testid="check-summary"]')!;

describe('Import row problems (C10 on the new page)', () => {
  it('a browser problem and a server problem are visible text at their spreadsheet rows, problems first; a role=status summary', async () => {
    actions.bulkImportEmployees.mockResolvedValueOnce({ ok: true, data: { created: 0, skipped: 0, errors: [{ row: 4, message: 'Role must be Employee, Supervisor or Admin.' }], skippedRows: [] } });
    m = await mount(<ImportClient initialData={importPageData()} initialType="people" />);
    await chooseFile(`${HEADER}\nAnn,ann@x.test,Employee,No\nBob,,Employee,No\nCat,cat@x.test,Boss,No\n`, 'people.csv');
    expect(checkRow(3).textContent).toContain('Email is required');
    expect(checkRow(4).textContent).toContain('Role must be Employee, Supervisor or Admin.');
    expect(checkRow(2).textContent).toContain('Ready');
    expect(checkRow(3).getAttribute('data-outcome')).toBe('problem');
    expect([...document.body.querySelectorAll('[data-testid="check-table"] tbody tr td:first-child')].map((td) => td.textContent)).toEqual(['3', '4', '2']);
    expect(document.body.querySelector('[data-testid="check-table"] [title]')).toBeNull();
    expect(summary().getAttribute('role')).toBe('status');
    expect(summary().textContent).toContain("1 row is ready. 2 rows have problems and won't be imported unless you fix them in the file and choose it again.");
  });

  it('a file missing required columns is refused at the file input, naming them; nothing is sent', async () => {
    m = await mount(<ImportClient initialData={importPageData()} initialType="people" />);
    await chooseFile('Name,Email\nAnn,ann@x.test\n', 'people.csv');
    expect(document.body.textContent).toContain('This file is missing required columns: Role, FLSA Exempt.');
    expect(actions.bulkImportEmployees).not.toHaveBeenCalled();
  });

  it('another type (contracts) shows its problems the same way', async () => {
    actions.bulkImportContracts.mockResolvedValueOnce({ ok: true, data: { created: 0, skipped: 0, errors: [{ row: 2, message: 'Type must be blank (prime), prime or sub.' }], skippedRows: [] } });
    m = await mount(<ImportClient initialData={importPageData()} initialType="contracts" />);
    await chooseFile('Contract Number,Name,Type\nC-1,One,FFP\nC-2,,prime\n', 'contracts.csv');
    expect(checkRow(2).textContent).toContain('Type must be blank (prime), prime or sub.');
    expect(checkRow(3).textContent).toContain('Name is required');
  });
});
