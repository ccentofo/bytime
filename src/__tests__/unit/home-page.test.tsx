// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * feature-plan-ux-navigation-home.md §4.5 / T10: Home renders the attention items, the mini cadence (aria-hidden, with
 * a text summary), the team counts, and — admins only — the Contracts card labelled "priced cost" with unpriced labels,
 * tier words and CURRENT_RATES_NOTE; the empty state is "You're all caught up."; axe clean.
 */

vi.mock('next/navigation', () => ({ usePathname: () => '/home', useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { HomeClient } from '@/app/(app)/home/HomeClient';
import { attentionItems, type HomeView } from '@/lib/home/attention';
import { CURRENT_RATES_NOTE } from '@/lib/cost-labels';
import { installDomStubs, mount, unmount, type Mounted } from '../helpers/dom';
import { expectNoAxeViolations } from '../helpers/axe';

const empty = { count: 0, names: [] as string[] };
const TEAM = { submitted: { count: 3, names: ['A', 'B', 'C'] }, returned: { count: 1, names: ['R'] }, inProgress: { count: 2, names: ['P', 'Q'] }, notStarted: { count: 4, names: ['N1', 'N2', 'N3', 'N4'] } };

function view(o: Partial<HomeView> = {}): HomeView {
  return {
    role: 'admin',
    today: '2026-10-07',
    waiting: { count: 6, people: 5, names: ['Ann', 'Bob', 'Cat', 'Dan'], oldestPeriodLabel: 'Sep 16 – Sep 30, 2026' },
    myPeriod: {
      periodStart: '2026-10-01', periodEnd: '2026-10-15', periodLabel: 'Oct 1 – Oct 15, 2026', status: 'draft', submissionDeadline: 'Oct 15, 2026',
      totalHoursEntered: 24, expectedWorkdays: 5, workdaysFilled: 3, dailyHours: { '2026-10-01': 8, '2026-10-02': 8, '2026-10-05': 8, '2026-10-04': 2 },
    },
    team: TEAM,
    lastTeam: { submitted: { count: 1, names: ['Z'] }, returned: empty, inProgress: { count: 1, names: ['Yan'] }, notStarted: { count: 1, names: ['Xia'] } },
    lastPeriodLabel: 'Sep 16 – Sep 30, 2026',
    admin: {
      notices: { selfApprovalBackOn: null, recommendDesignee: true },
      contracts: [
        { contractId: 'k1', contractName: 'NAVAIR', status: 'active', fundedValue: '100000', pricedCost: 95000, unpricedHours: 12.5 },
        { contractId: 'k2', contractName: 'DHS', status: 'active', fundedValue: '100000', pricedCost: 20000, unpricedHours: 0 },
        { contractId: 'k3', contractName: 'Old', status: 'closed', fundedValue: '100000', pricedCost: 99000, unpricedHours: 0 },
        { contractId: 'k4', contractName: 'Unfunded', status: 'active', fundedValue: null, pricedCost: 5000, unpricedHours: 0 },
      ],
      unpricedTotal: 30,
      workweekSet: false,
      pendingConfig: { effectiveFrom: '2026-11-01' },
      overlaps: 2,
      setup: { isComplete: false, done: 5, total: 7, steps: [{ key: 'contracts', done: true, required: true }, { key: 'chargeCodeAccess', done: false, required: true }] },
    },
    ...o,
  };
}

beforeAll(installDomStubs);
let m: Mounted | undefined;
afterEach(() => { unmount(m); m = undefined; });

describe('Home (T10)', () => {
  it('admin: every attention item fires, in order, with its button', () => {
    expect(attentionItems(view()).map((i) => [i.key, i.action?.href ?? null])).toEqual([
      ['waiting', '/admin/approvals'],
      ['last-period', null],
      ['unpriced', '/admin/labor-categories?report=unpriced'],
      ['self-approval', '/admin/users'],
      ['setup', '/admin/setup'],
      ['workweek', '/settings/workspace'],
      ['pay-schedule', '/settings/pay-schedule'],
      ['contracts', '/admin/dashboard'],
      ['overlaps', '/admin/labor-categories'],
    ]);
    const items = attentionItems(view());
    expect(items[0]).toMatchObject({ title: '6 timesheets waiting for your approval', sentence: 'Ann, Bob, Cat, Dan and 1 more. Oldest: Sep 16 – Sep 30, 2026.' });
    expect(items[1]).toMatchObject({ title: '2 people haven’t submitted Sep 16 – Sep 30, 2026', sentence: 'Xia, Yan.' });
    expect(items[4]).toMatchObject({ title: 'Finish setting up: 5 of 7 done', sentence: 'Give each employee the charge codes they may use.' });
    // Only ACTIVE contracts at Watch or above; closed and unfunded never appear.
    expect(items[7]).toMatchObject({ title: '1 contract needs a look', sentence: 'NAVAIR (Near limit)' });
  });

  it('renders the items, the aria-hidden cadence with its text summary, team counts, and the admin Contracts card', async () => {
    m = await mount(<HomeClient view={view()} />);
    expect(m.container.querySelector('h1')!.textContent).toBe('Home');
    expect(m.container.querySelectorAll('[data-testid^="attention-"]')).toHaveLength(9);
    const cadence = m.container.querySelector('[data-testid="cadence"]')!;
    expect(cadence.getAttribute('aria-hidden')).toBe('true');
    expect(cadence.children).toHaveLength(15);
    expect(cadence.querySelector('[data-today]')).not.toBeNull();
    expect(m.container.querySelector('[data-testid="cadence-summary"]')!.textContent).toBe('24 hours entered. 3 of 5 workdays so far are filled in.');
    const team = m.container.querySelector('[data-testid="team"]')!.textContent!;
    expect(team).toContain('Submitted: 3');
    expect(team).toContain('In progress: 3 (1 returned)');
    expect(team).toContain('Not started: 4');
    const card = m.container.querySelector('[data-testid="contracts"]')!.textContent!;
    expect(card).toContain('priced cost');
    expect(card).not.toMatch(/spent/i);
    expect(card).toContain('12.5 hours unpriced');
    expect(card).toContain('Near limit');
    expect(card).toContain('On track');
    expect(card).not.toContain('Old');       // closed
    expect(card).not.toContain('Unfunded');  // no funding set
    expect(m.container.textContent).toContain(CURRENT_RATES_NOTE);
    await expectNoAxeViolations(document.body);
  });

  it('supervisor: no money anywhere', async () => {
    m = await mount(<HomeClient view={view({ role: 'supervisor', admin: null })} />);
    expect(m.container.querySelector('[data-testid="contracts"]')).toBeNull();
    expect(m.container.textContent).not.toMatch(/\$|priced cost/);
  });

  it('empty state: "You\'re all caught up."', async () => {
    const quiet = view({ waiting: { count: 0, people: 0, names: [], oldestPeriodLabel: null }, lastTeam: { submitted: { count: 2, names: ['a', 'b'] }, returned: empty, inProgress: empty, notStarted: empty }, role: 'supervisor', admin: null });
    expect(attentionItems(quiet)).toEqual([]);
    m = await mount(<HomeClient view={quiet} />);
    expect(m.container.querySelector('[data-testid="all-caught-up"]')!.textContent).toBe('You’re all caught up.'.replace('’', "'"));
  });

  it('static: home/page.tsx guards with requirePageRole(\'approver\') first and redirects on the fresh-role fall-through', () => {
    const src = readFileSync(path.resolve(__dirname, '../../app/(app)/home/page.tsx'), 'utf8');
    const body = src.slice(src.indexOf('export default async function'));
    expect(body.indexOf("await requirePageRole('approver')")).toBeGreaterThan(-1);
    expect(body.indexOf("await requirePageRole('approver')")).toBeLessThan(body.indexOf('getHomeData('));
    expect(body).toMatch(/if \('redirect' in data\) redirect\(data\.redirect\);/);
    expect(src).toContain("export const metadata: Metadata = { title: 'Home' };");
  });
});
