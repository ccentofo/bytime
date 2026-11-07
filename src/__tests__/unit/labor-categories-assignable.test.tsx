// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';

/**
 * feature-plan-ux-page-fixes.md C4, moved with the assign form to People → Assignments → "Labor categories"
 * (feature-plan-ux-kit-contracts.md §4.3, L1): the assign form offers only the ASSIGNABLE categories (the page's
 * getAssignableLaborCategories), each labelled with its CURRENT rate from the page's rateByCategory (never a starting
 * rate). The table's Rate column reads the same map, so an assignment shows its category's current rate.
 */

const assign = vi.hoisted(() => vi.fn());
vi.mock('@/server/actions/labor-categories', () => ({
  assignUserToLaborCategory: assign, endUserLaborCategoryAssignment: vi.fn(), getUserLaborCategoryAssignments: vi.fn(),
}));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

import { LaborCategoryAssignmentsPanel } from '@/app/(app)/admin/assignments/LaborCategoryAssignmentsPanel';
import { click, installDomStubs, mount, unmount, type Mounted } from '../helpers/dom';
import type { CalendarDate } from '@/lib/calendar-date';

beforeAll(installDomStubs);
let m: Mounted | undefined;
afterEach(() => { unmount(m); m = undefined; });

const L1 = '11111111-1111-4111-8111-111111111111';
const L2 = '22222222-2222-4222-8222-222222222222';

async function render() {
  m = await mount(
    <LaborCategoryAssignmentsPanel
      initialAssignments={[{ id: 'a1', userId: 'u1', laborCategoryId: L1, effectiveDate: '2026-01-01', endDate: null, userName: 'Pat', lcatCode: 'SE-I', lcatTitle: 'SE-I title', clinNumber: '0001', contractName: 'NAVAIR', contractNumber: 'N1' }] as never}
      users={[{ id: 'u1', fullName: 'Pat Doe' }]}
      assignableLcats={[{ id: L1, lcatCode: 'SE-I', title: 'SE-I title', clinNumber: '0001', contractName: 'NAVAIR' }]}
      rateByCategory={{ [L1]: '110.00', [L2]: '90.00' }}
      categoryNames={{ [L1]: { lcatCode: 'SE-I', clinNumber: '0001' }, [L2]: { lcatCode: 'SE-II', clinNumber: '0001' } }}
      today={'2027-02-01' as CalendarDate}
      filters={{ laborCategoryId: null, userId: null, assignments: [] }}
      onRemoveFilter={() => {}}
    />,
  );
  // UX-4c §4.3: the form is in a Modal opened by "Assign a labor category".
  await click([...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Assign a labor category'));
}

describe('the assign form (C4, moved)', () => {
  it('offers only the assignable categories, each with its current rate; the table shows the current rate', async () => {
    await render();
    const label = [...document.body.querySelectorAll('label')].find((l) => l.textContent?.startsWith('Labor Category'))!;
    const input = document.getElementById(label.htmlFor)!;
    await click(input);
    const listbox = document.getElementById(input.getAttribute('aria-controls')!)!;
    const options = [...listbox.querySelectorAll('[role="option"]')].map((o) => o.textContent);
    expect(options).toEqual(['NAVAIR — 0001 — SE-I: SE-I title ($110.00/hr)']);
    const row = m!.container.querySelector('tbody tr[data-row="lcat"]')!;
    expect(row.textContent).toContain('$110.00/hr');
  });
});

describe('UX-4B1-AUDIT L13: the Assign button keeps focus', () => {
  it('never `disabled`; incomplete → aria-disabled with the reason; a click shows the missing fields and calls nothing', async () => {
    await render();
    const button = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Assign')!;
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    const hint = document.body.querySelector('[data-testid="assign-hint"]')!;
    expect(button.getAttribute('aria-describedby')).toBe(hint.id);
    expect(hint.textContent).toBe('Choose an employee, a labor category and an effective date.');
    expect(document.body.textContent).not.toContain('Choose an employee.');
    await click(button);
    expect(assign).not.toHaveBeenCalled();
    for (const msg of ['Choose an employee.', 'Choose a labor category.', 'Enter the effective date.']) expect(document.body.textContent).toContain(msg);
  });
});

