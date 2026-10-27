// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * feature-plan-ux-navigation-home.md §4.7 / T15 (UX-AUDIT B1): the Setup Wizard shows the 7 steps that make a
 * timesheet usable, in order, with copy that no longer says "CLINs are the charge codes"; "Create one per CLIN" calls
 * autobridgeChargeCodesFromClins; the done screen leads to Home.
 */

const actions = vi.hoisted(() => ({
  autobridge: vi.fn(async () => ({ ok: true, data: { created: 2, total: 2 } })),
  getSetupStatus: vi.fn(),
}));
vi.mock('@/server/actions/charge-codes', () => ({ autobridgeChargeCodesFromClins: actions.autobridge }));
vi.mock('@/server/actions/setup', () => ({ getSetupStatus: actions.getSetupStatus }));
vi.mock('@/server/actions/indirect-codes', () => ({ seedIndirectCodes: vi.fn() }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

import { SetupWizardClient, STEPS } from '@/app/(app)/admin/setup/SetupWizardClient';
import type { SetupStatus } from '@/server/internal/setup';
import { buttonByText, click, installDomStubs, mount, unmount, type Mounted } from '../helpers/dom';
import { expectNoAxeViolations } from '../helpers/axe';

function status(o: Partial<SetupStatus>): SetupStatus {
  const c = { indirectCodes: 0, contracts: 1, clins: 1, chargeCodes: 0, laborCategories: 0, employees: 3, employeesWithAccess: 0, ...o };
  const steps: SetupStatus['steps'] = [
    { key: 'indirectCodes', done: c.indirectCodes > 0, required: false },
    { key: 'contracts', done: c.contracts > 0, required: true },
    { key: 'clins', done: c.clins > 0, required: true },
    { key: 'chargeCodes', done: c.chargeCodes > 0, required: true },
    { key: 'laborCategories', done: c.laborCategories > 0, required: false },
    { key: 'employees', done: c.employees > 0, required: true },
    { key: 'chargeCodeAccess', done: c.employeesWithAccess > 0, required: true },
  ];
  const isComplete = c.contracts > 0 && c.clins > 0 && c.chargeCodes > 0 && c.employeesWithAccess > 0;
  return { ...c, steps, isComplete, done: steps.filter((s) => s.done).length, total: 7, ...o };
}

beforeAll(installDomStubs);
let m: Mounted | undefined;
afterEach(() => { unmount(m); m = undefined; vi.clearAllMocks(); });
const ROOT = path.resolve(__dirname, '../../..');

describe('Setup Wizard (T15)', () => {
  it('7 steps in order, with Charge codes and Charge code access', () => {
    expect(STEPS.map((s) => [s.key, s.title, s.required])).toEqual([
      ['indirectCodes', 'Indirect charge codes', false],
      ['contracts', 'Contracts', true],
      ['clins', 'CLINs', true],
      ['chargeCodes', 'Charge codes', true],
      ['laborCategories', 'Labor categories', false],
      ['employees', 'Employees', true],
      ['chargeCodeAccess', 'Charge code access', true],
    ]);
  });

  it('new copy: charge codes explained, access counts "n of m employees", no "CLINs are the charge codes" anywhere', async () => {
    m = await mount(<SetupWizardClient initialStatus={status({ chargeCodes: 2, employeesWithAccess: 1 })} />);
    const src = readFileSync(path.join(ROOT, 'src/app/(app)/admin/setup/SetupWizardClient.tsx'), 'utf8');
    expect(src).not.toMatch(/CLINs are the charge codes/i);
    expect(src).not.toMatch(/explicitly assigned to/);
    expect(src).toContain('Charge codes are what employees log time against. Each one belongs to a CLIN.');
    expect(STEPS.find((s) => s.key === 'chargeCodeAccess')!.helpText(status({ employees: 4, employeesWithAccess: 1 })))
      .toBe('Give each employee the charge codes they may use. 1 of 4 employees have at least one.');
    expect(STEPS.find((s) => s.key === 'chargeCodeAccess')!.linkHref).toBe('/admin/assignments');
  });

  it('"Create one per CLIN" on the Charge codes step calls autobridgeChargeCodesFromClins and refreshes', async () => {
    actions.getSetupStatus.mockResolvedValue(status({ chargeCodes: 2 }));
    m = await mount(<SetupWizardClient initialStatus={status({})} />);
    await click(buttonByText('Create one per CLIN'));
    expect(actions.autobridge).toHaveBeenCalledTimes(1);
    expect(actions.getSetupStatus).toHaveBeenCalled();
    await expectNoAxeViolations(document.body);
  });

  it('done screen: "Setup complete", Go to Home → /home, Open timesheet → /timesheet', async () => {
    m = await mount(<SetupWizardClient initialStatus={status({ chargeCodes: 1, employeesWithAccess: 2 })} />);
    expect(m.container.querySelector('h1')!.textContent).toBe('Setup complete');
    const link = (text: string) => [...m!.container.querySelectorAll('a')].find((a) => a.textContent?.trim() === text)!;
    expect(link('Go to Home').getAttribute('href')).toBe('/home');
    expect(link('Open timesheet').getAttribute('href')).toBe('/timesheet');
  });
});
