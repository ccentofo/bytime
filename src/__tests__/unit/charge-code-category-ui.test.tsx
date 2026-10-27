// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * feature-plan-dated-rates.md D3 UI: the charge-code "Labor category" modal — only DR-Q2 categories are offered;
 * "No labor category" only for the starting category; the same Preview → Reason + checkbox gate; on ok the page merges
 * the returned schedule; on failure the error shows and the form stays. Both modals render the shared table.
 */

const actions = vi.hoisted(() => ({ preview: vi.fn(), add: vi.fn(), correct: vi.fn(), remove: vi.fn() }));
vi.mock('@/server/actions/charge-code-categories', () => ({
  previewChargeCodeCategoryImpact: actions.preview, addChargeCodeCategoryChange: actions.add,
  correctChargeCodeCategory: actions.correct, removeChargeCodeCategoryChange: actions.remove,
}));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));
vi.mock('@mantine/dates', () => ({
  DateInput: ({ onChange, value, 'data-testid': t }: { onChange: (v: string | null) => void; value: string | null; 'data-testid'?: string }) =>
    <input data-testid={t} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} />,
}));
vi.mock('@mantine/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantine/core')>();
  return {
    ...actual,
    Select: ({ data, value, onChange, 'data-testid': t }: { data: Array<{ value: string; label: string }>; value: string | null; onChange: (v: string | null) => void; 'data-testid'?: string }) => (
      <select data-testid={t} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
        <option value="" />
        {data.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    ),
  };
});

import { MantineProvider } from '@mantine/core';
import { ChargeCodeCategoryModal } from '@/app/(app)/admin/charge-codes/ChargeCodeCategoryModal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({ matches: false, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }),
  });
});

const K = '11111111-1111-4111-8111-111111111111';
const L = '22222222-2222-4222-8222-222222222222';
const M = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const categories = [
  { id: L, lcatCode: 'L', title: 'Lead', clinId: 'c1', slinId: null, status: 'active' },
  { id: M, lcatCode: 'M', title: 'Mid', clinId: 'c1', slinId: null, status: 'active' },
  { id: OTHER, lcatCode: 'O', title: 'Other CLIN', clinId: 'c2', slinId: null, status: 'active' },
];

let container: HTMLDivElement;
let root: Root;
let saved: unknown[];
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); saved = []; vi.clearAllMocks(); });
afterEach(() => { act(() => root.unmount()); container.remove(); document.body.innerHTML = ''; });

async function render(starting: string | null, changes: Array<{ id: string; effectiveDate: string; laborCategoryId: string }> = []) {
  await act(async () => {
    root.render(
      <MantineProvider env="test">
        <ChargeCodeCategoryModal opened onClose={() => {}} canWrite categories={categories}
          code={{ id: K, code: 'NAV-1', clinId: 'c1', slinId: null, schedule: { starting, changes: changes as never } }}
          onSaved={(v) => saved.push(v)} />
      </MantineProvider>,
    );
  });
}
const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
async function click(el: Element | null) { await act(async () => { (el as HTMLElement).click(); }); }
async function setValue(id: string, value: string) {
  const el = q(id) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}
const optionValues = () => [...(q('cat-category') as HTMLSelectElement).options].map((o) => o.value).filter(Boolean);
const ack = () => document.querySelector('[data-testid="cat-ack"] input, input[data-testid="cat-ack"]') as HTMLInputElement;

describe('ChargeCodeCategoryModal (D3)', () => {
  it('DR-Q2: only the code\'s CLIN categories are offered; "No labor category" only when correcting the starting category', async () => {
    await render(L);
    await click(q('cat-start-add'));
    expect(optionValues()).toEqual([L, M]);
    await click(q('cat-correct-starting'));
    expect(optionValues()).toEqual(['__none__', L, M]);
  });

  it('"No labor category" is not offered when correcting a dated change (a dated change must name a category)', async () => {
    await render(L, [{ id: 'x1', effectiveDate: '2027-03-01', laborCategoryId: M }]);
    await click(q('cat-correct-x1'));
    expect((q('cat-category') as HTMLSelectElement).value).toBe(M);
    expect(optionValues()).toEqual([L, M]);
  });

  it('gate: Add needs a preview, then reason + checkbox when re-pricing; a category change clears it; ok → merged', async () => {
    actions.preview.mockResolvedValue({ ok: true, data: { hours: '8.00', from: '2027-03-01', toExclusive: null, reasonRequired: true } });
    actions.add.mockResolvedValue({ ok: true, data: { chargeCodeId: K, starting: L, changes: [{ id: 'x1', effectiveDate: '2027-03-01', laborCategoryId: M }] } });
    await render(L);
    await click(q('cat-start-add'));
    await setValue('cat-date', '2027-03-01');
    expect((q('cat-category') as HTMLSelectElement).value).toBe(L); // prefilled with the category in effect
    await setValue('cat-category', M);
    expect((q('cat-save') as HTMLButtonElement).disabled).toBe(true);
    await click(q('cat-preview'));
    expect(q('cat-impact')!.textContent).toBe('This changes the cost of 8.00 recorded hours (from Mar 1, 2027).');
    await setValue('cat-reason', 'rebid');
    await click(ack());
    expect((q('cat-save') as HTMLButtonElement).disabled).toBe(false);
    await setValue('cat-category', L); // value change clears the gate
    expect(q('cat-impact')).toBeNull();
    await setValue('cat-category', M);
    await click(q('cat-preview'));
    await setValue('cat-reason', 'rebid');
    await click(ack());
    await click(q('cat-save'));
    expect(actions.add).toHaveBeenCalledWith({ chargeCodeId: K, effectiveDate: '2027-03-01', laborCategoryId: M, reason: 'rebid' });
    expect(saved).toEqual([{ chargeCodeId: K, starting: L, changes: [{ id: 'x1', effectiveDate: '2027-03-01', laborCategoryId: M }] }]);
  });

  it('first category (starting null, nothing re-priced): no reason needed; on failure the error shows and the form stays', async () => {
    actions.preview.mockResolvedValue({ ok: true, data: { hours: '0.00', from: null, toExclusive: null, reasonRequired: false } });
    actions.correct.mockResolvedValue({ ok: false, code: 'validation', error: 'That labor category belongs to a different CLIN or SLIN than this charge code.' });
    await render(null);
    await click(q('cat-correct-starting'));
    await setValue('cat-category', L);
    await click(q('cat-preview'));
    expect(q('cat-impact')!.textContent).toBe('No recorded hours are affected.');
    await click(q('cat-save'));
    expect(q('cat-error')!.textContent).toMatch(/different CLIN or SLIN/);
    expect((q('cat-category') as HTMLSelectElement).value).toBe(L);
    expect(saved).toEqual([]);
  });

  it('static: both modals render the shared EffectiveDatedTable; the charge codes page merges the returned schedule', () => {
    const ROOT = path.resolve(__dirname, '../../..');
    for (const rel of ['src/app/(app)/admin/labor-categories/RateScheduleModal.tsx', 'src/app/(app)/admin/charge-codes/ChargeCodeCategoryModal.tsx']) {
      expect(readFileSync(path.join(ROOT, rel), 'utf8'), rel).toMatch(/<EffectiveDatedTable/);
    }
    const client = readFileSync(path.join(ROOT, 'src/app/(app)/admin/charge-codes/ChargeCodesClient.tsx'), 'utf8');
    expect(client).toMatch(/onSaved=\{mergeCategorySchedule\}/);
    expect(client).toMatch(/c\.id === view\.chargeCodeId \? \{ \.\.\.c, laborCategoryId: view\.starting, categoryChanges: view\.changes \}/);
  });
});
