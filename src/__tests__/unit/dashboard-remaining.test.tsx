// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';

/**
 * Certified outputs fix round 1, F5 (CO-D17): every "Remaining" funding figure — overview card, contract row, CLIN row,
 * SLIN row — says "based on priced cost" and links to the unpriced hours while any are unpriced; F11: the links land on
 * the report (#cost-basis-reports).
 */

vi.mock('@/server/actions/dashboard', () => ({ getPeriodCostReport: vi.fn(async () => []) }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

import { DashboardClient } from '@/app/(app)/admin/dashboard/DashboardClient';
import type { ContractSummary } from '@/server/actions/dashboard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({ matches: false, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }),
  });
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });

const summary = (unpriced: number): ContractSummary => ({
  contractId: 'k1', contractNumber: 'N-1', contractName: 'NAVAIR', contractType: 'prime', status: 'active', fundedValue: '100000', ceilingValue: null,
  totalHours: 50, totalCost: 4000, unpricedHours: unpriced,
  clinSummaries: [{
    clinId: 'c1', clinNumber: '0001', description: 'Eng', fundedAmount: '50000', status: 'active', totalHours: 50, totalCost: 4000, unpricedHours: unpriced,
    slinSummaries: [{ slinId: 's1', slinNumber: '0001AA', description: 'Sub', fundedAmount: '10000', status: 'active', totalHours: 10, totalCost: 800, unpricedHours: unpriced }],
  }],
} as unknown as ContractSummary);

const notes = () => [...container.querySelectorAll('[data-testid="priced-basis-note"]')];

async function renderAndExpand(unpriced: number) {
  await act(async () => { root.render(<MantineProvider><DashboardClient initialSummaries={[summary(unpriced)]} /></MantineProvider>); });
  const expand = container.querySelector('button[aria-label="Expand"]') as HTMLButtonElement | null;
  expect(expand, 'row expand button').not.toBeNull();
  await act(async () => { expand!.click(); });
}

describe('Remaining figures carry the priced-cost flag (F5)', () => {
  it('with unpriced hours: overview card, contract row, CLIN row and SLIN row each say "based on priced cost" with the link', async () => {
    await renderAndExpand(12);
    const found = notes();
    expect(found).toHaveLength(4);
    for (const n of found) {
      expect(n.textContent).toContain('based on priced cost');
      expect(n.textContent).toContain('12 hours unpriced');
      expect(n.querySelector('a')!.getAttribute('href')).toMatch(/^\/admin\/labor-categories\?report=unpriced.*#cost-basis-reports$/);
    }
    const hrefs = found.map((n) => n.querySelector('a')!.getAttribute('href'));
    expect(hrefs).toEqual(expect.arrayContaining([
      '/admin/labor-categories?report=unpriced#cost-basis-reports',
      '/admin/labor-categories?report=unpriced&contractId=k1#cost-basis-reports',
      '/admin/labor-categories?report=unpriced&clinId=c1#cost-basis-reports',
      '/admin/labor-categories?report=unpriced&slinId=s1#cost-basis-reports',
    ]));
  });

  it('without unpriced hours: no note', async () => {
    await renderAndExpand(0);
    expect(notes()).toHaveLength(0);
  });
});
