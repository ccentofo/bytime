// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { readFileSync } from 'node:fs';

/**
 * feature-plan-ux-page-fixes.md C11 / T-C11: History import uploads are labelled Mantine FileInputs (focusable buttons
 * reachable by Tab), never a label around a hidden input; the copy promises only imports that exist; a new file — or a
 * file that can't be read — clears the previous file's rows, validation and filename first.
 */

type ParseConfig = { complete: (r: { data: Record<string, string>[] }) => void; error: (e: Error) => void };
const parses = vi.hoisted(() => [] as Array<{ file: File; cfg: ParseConfig }>);
vi.mock('papaparse', () => ({ default: { parse: (file: File, cfg: ParseConfig) => { parses.push({ file, cfg }); } } }));
const actions = vi.hoisted(() => ({
  validateMigrationData: vi.fn(async (rows: unknown[]) => ({ ok: true, data: rows.map((data, i) => ({ rowIndex: i + 1, data, errors: [], isValid: true })) })),
  validateMigrationPeriods: vi.fn(async (rows: unknown[]) => ({ ok: true, data: rows.map((data, i) => ({ rowIndex: i + 1, data, errors: [], isValid: true })) })),
  importMigrationData: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ ok: true, data: { imported: 1, skipped: 0, errors: [] } })),
  importMigrationPeriods: vi.fn(async () => ({ ok: true, data: { imported: 1, skipped: 0, errors: [] } })),
}));
vi.mock('@/server/actions/migration', () => actions);
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

import { MigrationClient } from '@/app/(app)/settings/migration/MigrationClient';
import { buttonByText, buttonsByText, click, installDomStubs, mount, unmount, wait, type Mounted } from '../helpers/dom';

beforeAll(installDomStubs);
let m: Mounted | undefined;
beforeEach(() => { vi.clearAllMocks(); parses.length = 0; });
afterEach(() => { unmount(m); m = undefined; });

const field = (text: string) => {
  const l = [...m!.container.querySelectorAll('label')].find((x) => x.textContent?.replace(/\s*\*\s*$/, '').trim() === text);
  return l ? document.getElementById(l.htmlFor) : null;
};
/** Mantine renders the FileInput's hidden <input type=file> just before its wrapper. */
const fileInputOf = (label: string) => field(label)!.closest('.mantine-InputWrapper-root')!.previousElementSibling as HTMLInputElement;
async function choose(label: string, name: string) {
  const input = fileInputOf(label);
  Object.defineProperty(input, 'files', { value: [new File(['x'], name, { type: 'text/csv' })], configurable: true });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
  return parses[parses.length - 1];
}
const entry = (email: string) => ({ 'Employee Email': email, 'Entry Date': '2025-01-06', 'Indirect Code': 'OH-001', Hours: '8' });

describe('History import (C11, T-C11)', () => {
  it('both uploads are labelled, focusable buttons reachable by Tab; no label around a hidden input', async () => {
    m = await mount(<MigrationClient />);
    const entries = field('Timesheet entries CSV')!;
    expect(entries.tagName).toBe('BUTTON');
    expect(entries.getAttribute('tabindex')).not.toBe('-1');
    expect(entries.textContent).toContain('Choose a CSV file');
    expect(fileInputOf('Timesheet entries CSV').getAttribute('type')).toBe('file');
    expect(fileInputOf('Timesheet entries CSV').getAttribute('accept')).toBe('.csv');
    expect(m.container.querySelector('label input[hidden], label > input[type="file"]')).toBeNull();
    await click([...m.container.querySelectorAll('[role="tab"]')].find((t) => t.textContent === 'Period Status'));
    expect(field('Period status CSV')!.tagName).toBe('BUTTON');
    const src = readFileSync('src/app/(app)/settings/migration/MigrationClient.tsx', 'utf8');
    expect(src).not.toMatch(/component="label"/);
  });

  it('the copy promises only imports that exist, with the import order and the Indirect codes link', async () => {
    m = await mount(<MigrationClient />);
    const text = m.container.textContent!;
    expect(text).toContain("Timesheet history can be imported only during onboarding, before your workspace's first submitted timesheet. Employees, contracts, CLINs and labor categories can be imported any time from Data import.");
    expect(text).not.toMatch(/users and charge codes|charge codes can be imported/i);
    expect(m.container.querySelector('[data-testid="migration-import-order"]')!.textContent).toContain(
      'Import order: 1. Add employees, contracts and CLINs (Data import) and any indirect codes (Indirect codes). 2. Import timesheet entries. 3. Import period statuses.',
    );
    expect([...m.container.querySelectorAll('a')].find((a) => a.textContent === 'Indirect codes')!.getAttribute('href')).toBe('/admin/charge-codes?tab=indirect');
  });

  it('a new file clears the old rows and filename before it is parsed; the import sends the new filename', async () => {
    m = await mount(<MigrationClient />);
    const first = await choose('Timesheet entries CSV', 'old.csv');
    await act(async () => { first.cfg.complete({ data: [entry('a@x.test'), entry('b@x.test')] }); });
    expect(buttonByText('Validate (2 rows)')).toBeDefined();

    const second = await choose('Timesheet entries CSV', 'new.csv');
    expect(buttonsByText('Validate (2 rows)')).toHaveLength(0);       // cleared before the new parse finishes
    await act(async () => { first.cfg.complete({ data: [entry('late@x.test')] }); });   // a stale parse is ignored
    expect(buttonsByText('Validate (1 rows)')).toHaveLength(0);
    await act(async () => { second.cfg.complete({ data: [entry('c@x.test')] }); });
    await click(buttonByText('Validate (1 rows)'));
    await wait();
    const source = field('Source system') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(source, 'Deltek');
      source.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(buttonByText('Import 1 Valid Rows'));
    await wait();
    expect(actions.importMigrationData).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'new.csv' }));
  });

  it('a period file that can\'t be read keeps the state cleared and says so', async () => {
    m = await mount(<MigrationClient />);
    await click([...m.container.querySelectorAll('[role="tab"]')].find((t) => t.textContent === 'Period Status'));
    const first = await choose('Period status CSV', 'periods.csv');
    await act(async () => { first.cfg.complete({ data: [{ 'Employee Email': 'a@x.test', 'Period Start': '2025-01-01', Status: 'approved' }] }); });
    expect(buttonByText('Validate (1 rows)')).toBeDefined();
    const bad = await choose('Period status CSV', 'bad.csv');
    await act(async () => { bad.cfg.error(new Error('unreadable')); });
    expect(buttonsByText('Validate (1 rows)')).toHaveLength(0);
    expect(m.container.textContent).toContain("Couldn't read that file. Make sure it's a CSV.");
  });

  // UX-4A-AUDIT.md L7 -------------------------------------------------------------------------------------------------
  const deferredOf = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };

  it('L7: a validation that finishes after another file was chosen is dropped', async () => {
    const pending = deferredOf<unknown>();
    actions.validateMigrationData.mockImplementationOnce(() => pending.promise as never);
    m = await mount(<MigrationClient />);
    const first = await choose('Timesheet entries CSV', 'old.csv');
    await act(async () => { first.cfg.complete({ data: [entry('old@x.test')] }); });
    await click(buttonByText('Validate (1 rows)'));
    const second = await choose('Timesheet entries CSV', 'new.csv');
    await act(async () => { second.cfg.complete({ data: [entry('new@x.test'), entry('new2@x.test')] }); });
    await act(async () => { pending.resolve({ ok: true, data: [{ rowIndex: 1, data: { employeeEmail: 'old@x.test' }, errors: [], isValid: true }] }); });
    await wait();
    expect(m.container.textContent).not.toContain('old@x.test');
    expect(buttonsByText('Import 1 Valid Rows')).toHaveLength(0);
    expect(buttonByText('Validate (2 rows)')).toBeDefined();
  });

  it('L7: an import that finishes after another file was chosen doesn\'t show its summary over the new file', async () => {
    const pending = deferredOf<unknown>();
    actions.importMigrationData.mockImplementationOnce(() => pending.promise);
    m = await mount(<MigrationClient />);
    const first = await choose('Timesheet entries CSV', 'old.csv');
    await act(async () => { first.cfg.complete({ data: [entry('old@x.test')] }); });
    await click(buttonByText('Validate (1 rows)'));
    const source = field('Source system') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(source, 'Deltek');
      source.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(buttonByText('Import 1 Valid Rows'));
    const second = await choose('Timesheet entries CSV', 'new.csv');
    await act(async () => { second.cfg.complete({ data: [entry('new@x.test')] }); });
    await act(async () => { pending.resolve({ ok: true, data: { imported: 1, skipped: 0, errors: [] } }); });
    await wait();
    expect(m.container.textContent).not.toMatch(/1 imported/);
  });

  it('L7: on the period tab too, a late validation or import from the previous file is dropped', async () => {
    const validating = deferredOf<unknown>();
    const importing = deferredOf<unknown>();
    actions.validateMigrationPeriods.mockImplementationOnce(() => validating.promise as never);
    m = await mount(<MigrationClient />);
    await click([...m.container.querySelectorAll('[role="tab"]')].find((t) => t.textContent === 'Period Status'));
    const period = (email: string) => ({ 'Employee Email': email, 'Period Start': '2025-01-01', Status: 'approved' });
    const first = await choose('Period status CSV', 'p-old.csv');
    await act(async () => { first.cfg.complete({ data: [period('old@x.test')] }); });
    await click(buttonByText('Validate (1 rows)'));
    const second = await choose('Period status CSV', 'p-new.csv');
    await act(async () => { second.cfg.complete({ data: [period('new@x.test')] }); });
    await act(async () => { validating.resolve({ ok: true, data: [{ rowIndex: 1, data: {}, errors: [], isValid: true }] }); });
    await wait();
    expect(buttonsByText('Import 1 Period Records')).toHaveLength(0);       // the stale validation didn't land

    // Validate the new file, start its import, then pick a third file before the import returns.
    await click(buttonByText('Validate (1 rows)'));
    const source = field('Source system') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(source, 'Deltek');
      source.dispatchEvent(new Event('input', { bubbles: true }));
    });
    actions.importMigrationPeriods.mockImplementationOnce(() => importing.promise as never);
    await click(buttonByText('Import 1 Period Records'));
    const third = await choose('Period status CSV', 'p-third.csv');
    await act(async () => { third.cfg.complete({ data: [period('third@x.test')] }); });
    await act(async () => { importing.resolve({ ok: true, data: { imported: 1, skipped: 0, errors: [] } }); });
    await wait();
    expect(m.container.textContent).not.toMatch(/1 imported/);
  });
});
