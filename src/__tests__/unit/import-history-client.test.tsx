// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { readFileSync } from 'node:fs';

/**
 * The Hours and Timesheet status types of the Import page (feature-plan-ux-setup-import.md §4.4), carrying over the old
 * history page's tests (feature-plan-ux-page-fixes.md C11, UX-4A-AUDIT.md L7): the upload is a labelled Mantine
 * FileInput (a focusable button), never a label around a hidden input; the source system comes first; a new file
 * replaces the old one and the import sends the new file's name; a check that finishes after another file was chosen is
 * dropped; a file that can't be read says so.
 */

const deferredOf = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
const valid = (rows: unknown[]) => ({ ok: true, data: rows.map((data, i) => ({ rowIndex: i + 1, data, errors: [], isValid: true })) });
const actions = vi.hoisted(() => ({
  validateMigrationData: vi.fn<(rows: unknown[]) => Promise<unknown>>(),
  validateMigrationPeriods: vi.fn<(rows: unknown[]) => Promise<unknown>>(),
  importMigrationData: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ ok: true, data: { imported: 1, skipped: 0, errors: [], batchId: 'b' } })),
  importMigrationPeriods: vi.fn(async () => ({ ok: true, data: { imported: 1, skipped: 0, errors: [], batchId: 'b' } })),
  getImportWindowStatus: vi.fn(async () => ({ open: true as boolean | null })),
}));
vi.mock('@/server/actions/migration', () => actions);
vi.mock('@/server/actions/import', () => ({}));
vi.mock('@/server/actions/setup', () => ({ getSetupPageData: vi.fn(async () => { throw new Error('not needed'); }) }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

import { ImportClient } from '@/app/(app)/settings/import/ImportClient';
import { buttonByText, click, installDomStubs, mount, unmount, wait, type Mounted } from '../helpers/dom';
import { chooseFile, importPageData } from '../helpers/import-page';

beforeAll(installDomStubs);
let m: Mounted | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  actions.validateMigrationData.mockImplementation(async (rows) => valid(rows));
  actions.validateMigrationPeriods.mockImplementation(async (rows) => valid(rows));
});
afterEach(() => { unmount(m); m = undefined; });

const HEADER = 'Employee Email,Entry Date,Contract Number,CLIN Number,Indirect Code,Hours';
const field = (text: string) => {
  const l = [...document.body.querySelectorAll('label')].find((x) => x.textContent?.replace(/\s*\*\s*$/, '').trim() === text);
  return l ? document.getElementById(l.htmlFor) : null;
};
async function setSource(value: string) {
  const source = field('Source system') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(source, value);
    source.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('Import → Hours and Timesheet status (C11, L7)', () => {
  it('the upload is a labelled, focusable button; the source system comes first; the template is the hours one', async () => {
    m = await mount(<ImportClient initialData={importPageData()} initialType="hours" />);
    const upload = field('CSV file')!;
    expect(upload.tagName).toBe('BUTTON');
    expect(upload.getAttribute('tabindex')).not.toBe('-1');
    expect(upload.textContent).toContain('Choose a CSV file');
    const input = document.body.querySelector('input[type="file"]')!;
    expect(input.getAttribute('accept')).toBe('.csv');
    expect(document.body.querySelector('label input[hidden], label > input[type="file"]')).toBeNull();
    expect(readFileSync('src/app/(app)/settings/import/ImportParts.tsx', 'utf8')).not.toMatch(/component="label"/);
    expect(field('Source system')!.compareDocumentPosition(upload) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.body.querySelector('a[href="/templates/migration-timesheet-template.csv"]')).not.toBeNull();
  });

  it('a new file replaces the old one; the import sends the new file name and every row', async () => {
    m = await mount(<ImportClient initialData={importPageData()} initialType="hours" />);
    await chooseFile(`${HEADER}\na@x.test,2025-01-06,,,OH-001,8\nb@x.test,2025-01-06,,,OH-001,8\n`, 'old.csv');
    expect(document.body.querySelector('[data-testid="import-file"]')!.textContent).toBe('old.csv · 2 rows');
    await click(buttonByText('Choose a different file'));
    await chooseFile(`${HEADER}\nc@x.test,2025-01-06,,,OH-001,8\n`, 'new.csv');
    expect(actions.validateMigrationData).toHaveBeenLastCalledWith([expect.objectContaining({ employeeEmail: 'c@x.test' })]);
    await setSource('Deltek');
    await click(buttonByText('Import 1 row of hours'));
    await wait();
    expect(actions.importMigrationData).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'new.csv', sourceSystem: 'Deltek', rows: [expect.objectContaining({ employeeEmail: 'c@x.test' })] }));
    expect(document.body.querySelector('[data-testid="done-summary"]')!.textContent).toContain('1 imported · 0 skipped · 0 problems');
  });

  it('L7: a check that finishes after another file was chosen is dropped', async () => {
    const pending = deferredOf<unknown>();
    actions.validateMigrationData.mockImplementationOnce(() => pending.promise);
    m = await mount(<ImportClient initialData={importPageData()} initialType="hours" />);
    await chooseFile(`${HEADER}\nold@x.test,2025-01-06,,,OH-001,8\n`, 'old.csv');
    await click(buttonByText('Choose a different file'));
    await chooseFile(`${HEADER}\nnew@x.test,2025-01-06,,,OH-001,8\nnew2@x.test,2025-01-06,,,OH-001,8\n`, 'new.csv');
    await act(async () => { pending.resolve({ ok: true, data: [{ rowIndex: 1, data: {}, errors: ['stale'], isValid: false }] }); });
    await wait();
    expect(document.body.textContent).not.toContain('stale');
    expect(document.body.querySelector('[data-testid="check-summary"]')!.textContent).toContain('All 2 rows are ready.');
  });

  it("a file that can't be read says so and nothing is checked", async () => {
    const Real = globalThis.FileReader;
    class Broken { onload: (() => void) | null = null; onerror: (() => void) | null = null; error = new Error('unreadable'); readAsText() { setTimeout(() => this.onerror?.(), 0); } }
    globalThis.FileReader = Broken as unknown as typeof FileReader;
    try {
      m = await mount(<ImportClient initialData={importPageData()} initialType="timesheetStatus" />);
      await chooseFile('Employee Email,Period Start,Status,Submitted At\na@x.test,2025-01-01,approved,2025-01-16\n', 'bad.csv');
      expect(document.body.textContent).toContain("Couldn't read that file. Make sure it's a CSV.");
      expect(actions.validateMigrationPeriods).not.toHaveBeenCalled();
    } finally {
      globalThis.FileReader = Real;
    }
  });
});
