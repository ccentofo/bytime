// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';

/**
 * feature-plan-dated-rates.md D2 / §9 rows "Display (D2)", "UI (D2)", "Static (wording)": the main table shows the rate
 * in effect on the injected workspace today plus the next change; the Rates modal gates Add behind Preview (and
 * Reason + checkbox when hours are re-priced); a value change clears the gate, typing the reason doesn't; on ok the
 * MAIN table shows the new current rate; on failure the error shows and the form stays. Assignments show current rates.
 */

const actions = vi.hoisted(() => ({ preview: vi.fn(), add: vi.fn(), correct: vi.fn(), remove: vi.fn() }));
vi.mock('@/server/actions/labor-category-rates', () => ({
  previewRateChangeImpact: actions.preview, addLaborCategoryRateChange: actions.add,
  correctLaborCategoryRate: actions.correct, removeLaborCategoryRateChange: actions.remove,
}));
vi.mock('@/server/actions/labor-categories', () => ({
  createLaborCategory: vi.fn(), updateLaborCategory: vi.fn(), getAllLaborCategories: vi.fn(),
  assignUserToLaborCategory: vi.fn(), endUserLaborCategoryAssignment: vi.fn(), getUserLaborCategoryAssignments: vi.fn(),
}));
vi.mock('@/server/actions/clins', () => ({ getClinsByContract: vi.fn() }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));
vi.mock('@mantine/dates', () => ({
  DateInput: ({ onChange, value, 'data-testid': testId }: { onChange: (v: string | null) => void; value: string | null; 'data-testid'?: string }) =>
    <input data-testid={testId} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} />,
}));

import { LaborCategoriesClient } from '@/app/(app)/admin/labor-categories/LaborCategoriesClient';
import type { CalendarDate } from '@/lib/calendar-date';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({ matches: false, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }),
  });
});

const L = '11111111-1111-4111-8111-111111111111';
const category = (changes: Array<{ id: string; effectiveDate: string; hourlyRate: string; ceilingRate: string | null }>) => ({
  id: L, clinId: 'c1', slinId: null, lcatCode: 'SE-III', title: 'Senior Engineer', hourlyRate: '100.00', ceilingRate: '150.00', status: 'active' as const,
  createdAt: new Date(), updatedAt: new Date(), clinNumber: '0001', clinDescription: null, contractName: 'NAVAIR', contractNumber: 'N1', slinNumber: null,
  rateChanges: changes as never,
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); vi.clearAllMocks(); });
afterEach(() => { act(() => root.unmount()); container.remove(); document.body.innerHTML = ''; });

async function render(today: string, changes: Parameters<typeof category>[0]) {
  await act(async () => {
    root.render(
      <MantineProvider env="test">
        <LaborCategoriesClient
          initialLaborCategories={[category(changes)] as never}
          initialAssignments={[{ id: 'a1', userId: 'u1', laborCategoryId: L, effectiveDate: '2026-01-01', endDate: null, createdAt: new Date(), userName: 'Pat', userEmail: 'p@x', lcatCode: 'SE-III', lcatTitle: 'Senior Engineer', clinNumber: '0001', contractName: 'NAVAIR', contractNumber: 'N1' }] as never}
          contracts={[]}
          users={[]}
          assignableLcats={[{ id: L, lcatCode: 'SE-III', title: 'Senior Engineer', clinId: 'c1', slinId: null, clinNumber: '0001', contractName: 'NAVAIR', contractNumber: 'N1', slinNumber: null }] as never}
          today={today as CalendarDate}
        />
      </MantineProvider>,
    );
  });
}
const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const btn = (id: string) => q(id) as HTMLButtonElement;
async function click(el: Element | null) { await act(async () => { (el as HTMLElement).click(); }); }
async function type(id: string, value: string) {
  const el = q(id) as HTMLInputElement | HTMLTextAreaElement;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
/** UX-1 §4.5: "Rates" moved into the row's "More actions" menu, which renders in a portal (document.body). */
async function openRates() {
  await click(document.querySelector('button[aria-label="More actions for SE-III"]'));
  await act(async () => new Promise((r) => setTimeout(r, 20)));
  await click([...document.body.querySelectorAll('[role="menuitem"]')].find((i) => i.textContent?.trim() === 'Rates') ?? null);
}
const ackBox = () => document.querySelector('[data-testid="rate-ack"] input, input[data-testid="rate-ack"]') as HTMLInputElement;

const twoChanges = [
  { id: 'x1', effectiveDate: '2027-01-01', hourlyRate: '110.00', ceilingRate: null },
  { id: 'x2', effectiveDate: '2027-04-01', hourlyRate: '120.00', ceilingRate: null },
];

describe('Display (D2): current rate on the injected today + the next change', () => {
  it('today 2027-02-01 → $110.00 and "→ $120.00 from Apr 1, 2027"; today 2026-12-31 → $100.00', async () => {
    await render('2027-02-01', twoChanges);
    expect(q('lcat-current-hourly')!.textContent).toBe('$110.00');
    expect(q('lcat-next-hourly')!.textContent).toBe('→ $120.00 from Apr 1, 2027');
    act(() => root.unmount());
    root = createRoot(container);
    await render('2026-12-31', twoChanges);
    expect(q('lcat-current-hourly')!.textContent).toBe('$100.00');
    expect(q('lcat-next-hourly')!.textContent).toBe('→ $110.00 from Jan 1, 2027');
  });

  it('the assignments table shows the assigned category\'s CURRENT rate (not the starting rate)', async () => {
    await render('2027-02-01', twoChanges);
    expect(document.body.textContent).toContain('$110.00/hr');
    expect(document.body.textContent).not.toContain('$100.00/hr');
  });
});

describe('UI (D2): the Rates modal gate', () => {
  async function openAdd() {
    await openRates();
    await click(q('rate-start-add'));
  }

  it('Add is disabled until Preview; reason + checkbox when re-pricing; a value change clears the gate, typing the reason doesn\'t; ok → main table updates', async () => {
    actions.preview.mockResolvedValue({ ok: true, data: { hours: '12.00', from: '2027-01-01', toExclusive: null, reasonRequired: true } });
    actions.add.mockResolvedValue({ ok: true, data: { laborCategoryId: L, starting: { hourlyRate: '100.00', ceilingRate: '150.00' }, changes: [{ id: 'new', effectiveDate: '2027-01-01', hourlyRate: '110.00', ceilingRate: null }] } });
    await render('2027-02-01', []);
    expect(q('lcat-current-hourly')!.textContent).toBe('$100.00');
    await openAdd();
    await type('rate-date', '2027-01-01');
    expect((q('rate-hourly') as HTMLInputElement).value).toBe('100.00'); // prefilled from the rate in effect on that date
    await type('rate-hourly', '110');
    expect(btn('rate-save').disabled).toBe(true); // no preview yet

    await click(q('rate-preview'));
    expect(actions.preview).toHaveBeenCalledWith({ kind: 'add', laborCategoryId: L, effectiveDate: '2027-01-01', hourlyRate: '110', ceilingRate: '150.00' }); // ceiling prefilled from the rate in effect
    expect(q('rate-impact')!.textContent).toBe('This changes the cost of 12.00 recorded hours (from Jan 1, 2027).');
    expect(btn('rate-save').disabled).toBe(true); // reason + checkbox still missing
    await type('rate-reason', 'option year');
    expect(btn('rate-save').disabled).toBe(true);
    await click(ackBox());
    expect(btn('rate-save').disabled).toBe(false);

    await type('rate-reason', 'option year 2'); // typing the reason does NOT clear the gate
    expect(btn('rate-save').disabled).toBe(false);
    await type('rate-hourly', '111');           // a value change DOES
    expect(btn('rate-save').disabled).toBe(true);
    expect(q('rate-impact')).toBeNull();
    expect(q('rate-reason')).toBeNull();

    await type('rate-hourly', '110');
    await click(q('rate-preview'));
    await type('rate-reason', 'option year');
    await click(ackBox());
    await click(q('rate-save'));
    expect(actions.add).toHaveBeenCalledWith({ laborCategoryId: L, effectiveDate: '2027-01-01', hourlyRate: '110', ceilingRate: '150.00', reason: 'option year' });
    expect(q('lcat-current-hourly')!.textContent).toBe('$110.00'); // merged into the page's laborCats
  });

  it('no re-priced hours: "No recorded hours are affected." and Add enables without a reason', async () => {
    actions.preview.mockResolvedValue({ ok: true, data: { hours: '0.00', from: '2028-01-01', toExclusive: null, reasonRequired: false } });
    await render('2027-02-01', []);
    await openAdd();
    await type('rate-date', '2028-01-01');
    await type('rate-hourly', '130');
    await click(q('rate-preview'));
    expect(q('rate-impact')!.textContent).toBe('No recorded hours are affected.');
    expect(q('rate-reason')).toBeNull();
    expect(btn('rate-save').disabled).toBe(false);
  });

  it('on failure the error shows and the form stays (values kept, main table unchanged)', async () => {
    actions.preview.mockResolvedValue({ ok: true, data: { hours: '0.00', from: '2028-01-01', toExclusive: null, reasonRequired: false } });
    actions.add.mockResolvedValue({ ok: false, code: 'conflict', error: 'There is already a rate change on 2028-01-01 for this labor category. Correct that one instead.' });
    await render('2027-02-01', []);
    await openAdd();
    await type('rate-date', '2028-01-01');
    await type('rate-hourly', '130');
    await click(q('rate-preview'));
    await click(q('rate-save'));
    expect(q('rate-error')!.textContent).toBe('There is already a rate change on 2028-01-01 for this labor category. Correct that one instead.');
    expect((q('rate-hourly') as HTMLInputElement).value).toBe('130');
    expect(q('lcat-current-hourly')!.textContent).toBe('$100.00');
  });
});

describe('UI (D2): Correct and Remove (audit L3)', () => {
  it('Correct a change: prefilled with its values; preview/save send the target; the main table shows the corrected current rate', async () => {
    actions.preview.mockResolvedValue({ ok: true, data: { hours: '8.00', from: '2027-01-01', toExclusive: '2027-04-01', reasonRequired: true } });
    actions.correct.mockResolvedValue({ ok: true, data: { laborCategoryId: L, starting: { hourlyRate: '100.00', ceilingRate: '150.00' }, changes: [{ ...twoChanges[0], hourlyRate: '112.00' }, twoChanges[1]] } });
    await render('2027-02-01', twoChanges);
    await openRates();
    expect(q('rate-remove-starting')).toBeNull(); // the starting rate can't be removed
    await click(q('rate-correct-x1'));
    expect((q('rate-hourly') as HTMLInputElement).value).toBe('110.00');
    await type('rate-hourly', '112');
    await click(q('rate-preview'));
    expect(actions.preview).toHaveBeenCalledWith({ kind: 'correct', laborCategoryId: L, target: 'x1', hourlyRate: '112', ceilingRate: null });
    expect(q('rate-impact')!.textContent).toBe('This changes the cost of 8.00 recorded hours (Jan 1, 2027 – Mar 31, 2027).');
    await type('rate-reason', 'mod 3');
    await click(ackBox());
    await click(q('rate-save'));
    expect(actions.correct).toHaveBeenCalledWith({ laborCategoryId: L, target: 'x1', hourlyRate: '112', ceilingRate: null, reason: 'mod 3' });
    expect(q('lcat-current-hourly')!.textContent).toBe('$112.00');
  });

  it('Remove a change: no value fields; preview/save send the change id; the main table drops the next-change line', async () => {
    actions.preview.mockResolvedValue({ ok: true, data: { hours: '4.00', from: '2027-04-01', toExclusive: null, reasonRequired: true } });
    actions.remove.mockResolvedValue({ ok: true, data: { laborCategoryId: L, starting: { hourlyRate: '100.00', ceilingRate: '150.00' }, changes: [twoChanges[0]] } });
    await render('2027-02-01', twoChanges);
    expect(q('lcat-next-hourly')).not.toBeNull();
    await openRates();
    await click(q('rate-remove-x2'));
    expect(q('rate-hourly')).toBeNull();
    await click(q('rate-preview'));
    expect(actions.preview).toHaveBeenCalledWith({ kind: 'remove', laborCategoryId: L, changeId: 'x2' });
    expect(q('rate-impact')!.textContent).toBe('This changes the cost of 4.00 recorded hours (from Apr 1, 2027).');
    expect(btn('rate-save').disabled).toBe(true);
    await type('rate-reason', 'wrong date');
    await click(ackBox());
    await click(q('rate-save'));
    expect(actions.remove).toHaveBeenCalledWith({ laborCategoryId: L, changeId: 'x2', reason: 'wrong date' });
    expect(q('lcat-next-hourly')).toBeNull();
  });
});

function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
const ZERO = { ok: true, data: { hours: '0.00', from: '2028-01-01', toExclusive: null, reasonRequired: false } };

describe('M1 / L5 (audit): a late preview never arms Save; closing the modal discards the half-done form', () => {
  async function openAdd() {
    await openRates();
    await click(q('rate-start-add'));
  }

  it('a value change while the preview is pending → after it resolves: no impact shown, Save disabled', async () => {
    const pending = deferred<unknown>();
    actions.preview.mockReturnValue(pending.promise);
    await render('2027-02-01', []);
    await openAdd();
    await type('rate-date', '2028-01-01');
    await type('rate-hourly', '130');
    await click(q('rate-preview'));
    await type('rate-date', '2025-01-01'); // changed while the preview runs
    await act(async () => { pending.resolve(ZERO); });
    expect(q('rate-impact')).toBeNull();
    expect(btn('rate-save').disabled).toBe(true);
  });

  it('a row\'s Correct clicked while an Add preview is pending → the late result is dropped', async () => {
    const pending = deferred<unknown>();
    actions.preview.mockReturnValue(pending.promise);
    await render('2027-02-01', twoChanges);
    await openAdd();
    await type('rate-date', '2028-01-01');
    await click(q('rate-preview'));
    await click(q('rate-correct-x1'));
    await act(async () => { pending.resolve(ZERO); });
    expect(q('rate-impact')).toBeNull();
    expect(btn('rate-save').disabled).toBe(true);
  });

  it('close and reopen the same category: the form, preview and reason are gone', async () => {
    actions.preview.mockResolvedValue(ZERO);
    await render('2027-02-01', []);
    await openAdd();
    await type('rate-date', '2028-01-01');
    await click(q('rate-preview'));
    expect(q('rate-impact')).not.toBeNull();
    await click(document.querySelector('.mantine-Modal-close'));
    await openRates();
    expect(q('rate-start-add')).not.toBeNull();
    expect(q('rate-date')).toBeNull();
    expect(q('rate-impact')).toBeNull();
  });
});

// ── Static (wording) ──────────────────────────────────────────────────────────────────────────────────────────
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (name === '__tests__' || name === 'node_modules') return [];
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

describe('Static (wording): the old footer sentence is gone from src/', () => {
  it('no src/ file (tests excluded) contains it; the new sentence is the constant', async () => {
    const OLD = ['Costs use current', 'labor-category rates.'].join(' '); // built so this file can't match itself
    const ROOT = path.resolve(__dirname, '../../..');
    const offenders = sourceFiles(path.join(ROOT, 'src')).filter((f) => readFileSync(f, 'utf8').includes(OLD)).map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
    const { CURRENT_RATES_NOTE } = await import('@/lib/cost-labels');
    expect(CURRENT_RATES_NOTE).toBe('Costs use the labor-category rate in effect on each day worked.');
    expect(readFileSync(path.join(ROOT, 'src/app/(app)/admin/api-keys/ApiKeysClient.tsx'), 'utf8')).toMatch(/<Code>hourlyRate<\/Code> is the labor-category rate in effect on that entry&apos;s date/);
  });

  it('the assignment dropdown label uses the current rate from the page\'s schedules', () => {
    const client = readFileSync(path.resolve(__dirname, '../../app/(app)/admin/labor-categories/LaborCategoriesClient.tsx'), 'utf8');
    expect(client).toMatch(/\(\$\{formatRate\(currentRateOf\(lc\.id\)\)\}\/hr\)/);
  });

  it('the assignment selects no longer return a starting rate', () => {
    const src = readFileSync(path.resolve(__dirname, '../../server/actions/labor-categories.ts'), 'utf8');
    const assignments = src.slice(src.indexOf('export async function getUserLaborCategoryAssignments'), src.indexOf('export async function assignUserToLaborCategory'));
    expect(assignments).not.toMatch(/hourlyRate/);
    const assignable = src.slice(src.indexOf('export async function getAssignableLaborCategories'));
    expect(assignable.slice(0, assignable.indexOf('.from('))).not.toMatch(/hourlyRate/);
  });
});
