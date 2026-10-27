// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';

/**
 * feature-plan-ux-foundations.md §4.4 / §4.5 (UX-1 audit L10): Assignments opts back into column filters and shows them;
 * its single "Deactivate…" action is hidden on inactive rows (the row stays listed as Inactive).
 */

vi.mock('@/server/actions/charge-codes', () => ({
  assignChargeCodeToUser: vi.fn(), unassignChargeCodeFromUser: vi.fn(), assignAllUnderClin: vi.fn(), getChargeCodeAssignments: vi.fn(async () => []),
}));
vi.mock('@/server/actions/assignments', () => ({ assignUserToClin: vi.fn(), unassignUserFromClin: vi.fn(), getAssignments: vi.fn(async () => []) }));
vi.mock('@/server/actions/clins', () => ({ getClinsByContract: vi.fn(async () => []) }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

import { AssignmentsClient } from '@/app/(app)/admin/assignments/AssignmentsClient';
import { buttonsByText, installDomStubs, mount, unmount, type Mounted } from '../helpers/dom';

const cc = (userName: string, code: string, isActive: boolean) => ({
  userId: `u-${code}`, userName, chargeCodeId: `cc-${code}`, code, name: `${code} name`, clinNumber: '0001', contractName: 'NAVAIR',
  contractNumber: 'N-1', workLocation: null, isActive, assignedAt: new Date('2026-01-01T00:00:00Z'),
});

beforeAll(installDomStubs);
let m: Mounted | undefined;
afterEach(() => { unmount(m); m = undefined; });

describe('Assignments table (L10)', () => {
  it('column filters are shown; Deactivate is offered on the active row only', async () => {
    m = await mount(
      <AssignmentsClient initialAssignments={[]} users={[]} contracts={[]} chargeCodes={[]} workspaceTimezone="America/New_York"
        initialChargeCodeAssignments={[cc('Pat Doe', 'NAV-01', true), cc('Lee Roe', 'NAV-02', false)]} />,
    );
    // MRT keeps the filter controls mounted inside a Collapse even when hidden — so check they're actually RENDERED.
    const isRendered = (el: Element) => {
      for (let n: Element | null = el; n; n = n.parentElement) {
        if ((n as HTMLElement).style?.display === 'none' || n.getAttribute('aria-hidden') === 'true' || n.hasAttribute('inert')) return false;
      }
      return true;
    };
    const filters = [...m.container.querySelectorAll('thead input, thead [role="checkbox"]')];
    expect(filters.length).toBeGreaterThan(0);
    expect(filters.some(isRendered)).toBe(true);
    expect(buttonsByText('Deactivate…')).toHaveLength(1);
    const rows = [...m.container.querySelectorAll('tbody tr')];
    const active = rows.find((r) => r.textContent?.includes('NAV-01'))!;
    const inactive = rows.find((r) => r.textContent?.includes('NAV-02'))!;
    expect(active.textContent).toContain('Deactivate…');
    expect(inactive.textContent).not.toContain('Deactivate');
    expect(inactive.textContent).toContain('Inactive');
  });
});
