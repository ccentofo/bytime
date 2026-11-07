// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { act } from 'react';
import path from 'path';

/**
 * feature-plan-ux-navigation-home.md §4.7 / T15 (UX-AUDIT B1): the Setup Wizard shows the 7 steps that make a
 * timesheet usable, in order, with copy that no longer says "CLINs are the charge codes"; "Create one per CLIN" calls
 * autobridgeChargeCodesFromClins; the done screen leads to Home.
 */

const actions = vi.hoisted(() => ({
  autobridge: vi.fn(async () => ({ ok: true, data: { created: 2, skipped: 0 } })),
  getSetupStatus: vi.fn(),
  getSetupAccessGaps: vi.fn(async () => ({ missingCount: 0, names: [] as string[] })),
  seedIndirectCodes: vi.fn(),
  notify: vi.fn(),
}));
vi.mock('@/server/actions/charge-codes', () => ({ autobridgeChargeCodesFromClins: actions.autobridge }));
vi.mock('@/server/actions/setup', () => ({ getSetupStatus: actions.getSetupStatus, getSetupAccessGaps: actions.getSetupAccessGaps }));
vi.mock('@/server/actions/indirect-codes', () => ({ seedIndirectCodes: actions.seedIndirectCodes }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: actions.notify } }));

import { SetupWizardClient, STEPS, firstIncompleteStep, stepState } from '@/app/(app)/admin/setup/SetupWizardClient';
import type { SetupStatus } from '@/server/internal/setup';
import { buttonByText, click, installDomStubs, mount, unmount, wait, type Mounted } from '../helpers/dom';
import { expectNoAxeViolations } from '../helpers/axe';

const shownMessages = () => actions.notify.mock.calls.map((c) => (c[0] as { message: string }).message);

function status(o: Partial<SetupStatus>): SetupStatus {
  const c = { indirectCodes: 0, contracts: 1, clins: 1, chargeCodes: 0, laborCategories: 0, employees: 3, employeesWithAccess: 0, ...o };
  const steps: SetupStatus['steps'] = [
    { key: 'indirectCodes', done: c.indirectCodes > 0, required: false },
    { key: 'contracts', done: c.contracts > 0, required: true },
    { key: 'clins', done: c.clins > 0, required: true },
    { key: 'chargeCodes', done: c.chargeCodes > 0, required: true },
    { key: 'laborCategories', done: c.laborCategories > 0, required: false },
    { key: 'employees', done: c.employees > 0, required: true },
    {
      key: 'chargeCodeAccess', done: c.employeesWithAccess > 0, required: true,
      allCovered: c.employees > 0 && c.employeesWithAccess >= c.employees, withAccess: c.employeesWithAccess, total: c.employees,
    },
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
    expect(STEPS.find((s) => s.key === 'indirectCodes')!.linkHref).toBe('/admin/charge-codes?tab=indirect');
  });

  it('"Create one per CLIN" on the Charge codes step calls autobridgeChargeCodesFromClins (no argument) and refreshes; CC-10: the toast counts `created`', async () => {
    actions.getSetupStatus.mockResolvedValue(status({ chargeCodes: 2 }));
    actions.autobridge.mockResolvedValueOnce({ ok: true, data: { created: 2, skipped: 1 } });
    m = await mount(<SetupWizardClient initialStatus={status({})} />);
    await click(buttonByText('Create one per CLIN'));
    expect(actions.autobridge).toHaveBeenCalledTimes(1);
    expect(actions.autobridge).toHaveBeenCalledWith();
    expect(shownMessages()).toContain('Created 2 charge codes');
    expect(actions.getSetupStatus).toHaveBeenCalled();
    await expectNoAxeViolations(document.body);
  });

  it('L12: no Mantine `loading` (it sets `disabled`) — a busy button is aria-disabled with a Loader, keeps focus, and ignores a second click', async () => {
    const src = readFileSync(path.join(ROOT, 'src/app/(app)/admin/setup/SetupWizardClient.tsx'), 'utf8');
    expect(src).not.toMatch(/\sloading=/);
    let finish!: (v: unknown) => void;
    actions.autobridge.mockImplementationOnce(() => new Promise((r) => { finish = r; }) as never);
    actions.getSetupStatus.mockResolvedValue(status({ chargeCodes: 2 }));
    m = await mount(<SetupWizardClient initialStatus={status({})} />);
    const bridge = buttonByText('Create one per CLIN') as HTMLButtonElement;
    bridge.focus();
    await click(bridge);
    expect([bridge.getAttribute('aria-busy'), bridge.getAttribute('aria-disabled'), bridge.hasAttribute('disabled')]).toEqual(['true', 'true', false]);
    expect(bridge.querySelector('.mantine-Loader-root')).not.toBeNull();
    expect(document.activeElement).toBe(bridge);
    await click(bridge);
    expect(actions.autobridge).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ ok: true, data: { created: 2, skipped: 0 } }); });
    await wait();
    expect(bridge.hasAttribute('aria-busy')).toBe(false);

    let refreshed!: (v: unknown) => void;
    actions.getSetupStatus.mockImplementationOnce(() => new Promise((r) => { refreshed = r; }) as never);
    const refresh = buttonByText('Refresh status') as HTMLButtonElement;
    await click(refresh);
    expect([refresh.getAttribute('aria-busy'), refresh.getAttribute('aria-disabled'), refresh.hasAttribute('disabled')]).toEqual(['true', 'true', false]);
    await act(async () => { refreshed(status({ chargeCodes: 2 })); });
    await wait();
    expect(refresh.hasAttribute('aria-busy')).toBe(false);
  });

  it('done screen: "Setup complete", Go to Home → /home, Open timesheet → /timesheet', async () => {
    m = await mount(<SetupWizardClient initialStatus={status({ chargeCodes: 1, employeesWithAccess: 2 })} />);
    expect(m.container.querySelector('h1')!.textContent).toBe('Setup complete');
    const link = (text: string) => [...m!.container.querySelectorAll('a')].find((a) => a.textContent?.trim() === text)!;
    expect(link('Go to Home').getAttribute('href')).toBe('/home');
    expect(link('Open timesheet').getAttribute('href')).toBe('/timesheet');
  });
});

// feature-plan-ux-page-fixes.md C3 / T-C3c: the wizard's seed says what actually happened.
describe('Setup Wizard seed message (C3)', () => {
  const shown = () => actions.notify.mock.calls.map((c) => (c[0] as { message: string }).message).join(' | ');
  const goToIndirectStep = () => click([...document.body.querySelectorAll('button.mantine-Stepper-step')].find((b) => b.textContent?.includes('Indirect charge codes')));

  it('created 0 → "none were added" (with where to reactivate them), never "9 … seeded"', async () => {
    actions.seedIndirectCodes.mockResolvedValue({ ok: true, data: { created: 0 } });
    actions.getSetupStatus.mockResolvedValue(status({}));
    m = await mount(<SetupWizardClient initialStatus={status({})} />);
    await goToIndirectStep();
    await click(buttonByText('Seed default DCAA codes'));
    expect(actions.seedIndirectCodes).toHaveBeenCalledTimes(1);
    expect(shown()).toContain('Your workspace already has indirect codes, so none were added. Reactivate them, and turn on Show on every timesheet, on the Indirect codes page.');
    expect(shown()).not.toMatch(/9 .*seeded|seeded/);
  });

  it('L5: created 1 → "Added 1 standard indirect code." (singular)', async () => {
    actions.seedIndirectCodes.mockResolvedValue({ ok: true, data: { created: 1 } });
    actions.getSetupStatus.mockResolvedValue(status({ indirectCodes: 1 }));
    m = await mount(<SetupWizardClient initialStatus={status({})} />);
    await goToIndirectStep();
    await click(buttonByText('Seed default DCAA codes'));
    expect(shown()).toContain('Added 1 standard indirect code.');
    expect(shown()).not.toContain('Added 1 standard indirect codes.');
  });

  it('created 9 → "Added 9 standard indirect codes."', async () => {
    actions.seedIndirectCodes.mockResolvedValue({ ok: true, data: { created: 9 } });
    actions.getSetupStatus.mockResolvedValue(status({ indirectCodes: 9 }));
    m = await mount(<SetupWizardClient initialStatus={status({})} />);
    await goToIndirectStep();
    await click(buttonByText('Seed default DCAA codes'));
    expect(shown()).toContain('Added 9 standard indirect codes.');
  });
});

// feature-plan-ux-page-fixes.md C17 (R2) --------------------------------------------------------------------------
const stepButton = (title: string) => [...document.body.querySelectorAll('button.mantine-Stepper-step')].find((b) => b.textContent?.includes(title)) as HTMLElement;
const hasCheck = (el: Element) => el.querySelector('.tabler-icon-check') !== null;

describe('Setup Wizard step states (C17, T-C17a)', () => {
  it('stepState and firstIncompleteStep: access is partial at 2 of 3; required todo first, then recommended, then partial', () => {
    expect(stepState(status({ employeesWithAccess: 2 }), 'chargeCodeAccess')).toBe('partial');
    expect(stepState(status({ employeesWithAccess: 3 }), 'chargeCodeAccess')).toBe('done');
    expect(stepState(status({ employeesWithAccess: 0 }), 'chargeCodeAccess')).toBe('todo');
    expect(firstIncompleteStep(status({ chargeCodes: 0 }))).toBe(3);
    expect(firstIncompleteStep(status({ chargeCodes: 1, employeesWithAccess: 3 }))).toBe(0);               // indirect codes
    expect(firstIncompleteStep(status({ indirectCodes: 9, chargeCodes: 1, laborCategories: 1, employeesWithAccess: 2 }))).toBe(6);
    expect(firstIncompleteStep(status({ indirectCodes: 9, chargeCodes: 1, laborCategories: 1, employeesWithAccess: 3 }))).toBe(7);
  });

  it('a skipped step before the active one says "Not done" and has no check', async () => {
    m = await mount(<SetupWizardClient initialStatus={status({ chargeCodes: 0 })} />);   // active: Charge codes
    const indirect = stepButton('Indirect charge codes');
    expect(indirect.textContent).toContain('Not done · Leave, overhead and G&A codes for total time accounting.');
    expect(hasCheck(indirect)).toBe(false);
    expect(stepButton('Contracts').textContent).toContain('Done · 1 contracts');
    expect(hasCheck(stepButton('Contracts'))).toBe(true);
  });

  it('access at 2 of 3: warning and "2 of 3 employees…" in the Stepper and the panel — never a check', async () => {
    m = await mount(<SetupWizardClient initialStatus={status({ chargeCodes: 0, employeesWithAccess: 2 })} />);
    const accessStep = stepButton('Charge code access');
    expect(accessStep.textContent).toContain('2 of 3 employees have a charge code');      // after `active`: carried by the text
    expect(hasCheck(accessStep)).toBe(false);
    await click(accessStep);
    const panel = document.body.querySelector('.mantine-Stepper-content')!;
    expect(panel.textContent).toContain('Partly done');
    expect(panel.textContent).toContain('1 of 3 employees still need a charge code.');
    expect(panel.textContent).not.toContain('✅');
    expect(hasCheck(stepButton('Charge code access'))).toBe(false);
  });

  it('access at 2 of 3 on the completion screen: the summary tile warns with the same text, never a check', async () => {
    m = await mount(<SetupWizardClient initialStatus={status({ chargeCodes: 1, employeesWithAccess: 2 })} />);
    const tile = m.container.querySelector('[data-step="chargeCodeAccess"]')!;
    expect(tile.getAttribute('data-state')).toBe('partial');
    expect(tile.textContent).toContain('1 of 3 employees still need a charge code.');
    expect(hasCheck(tile)).toBe(false);
    expect(tile.querySelector('.tabler-icon-alert-triangle')).not.toBeNull();
    expect(m.container.textContent).not.toContain('All 7 setup steps are done');
  });
});

describe('Setup Wizard refresh and gaps (C17, T-C17b)', () => {
  it('Refresh refetches the status and the gaps together and opens the next incomplete step', async () => {
    actions.getSetupStatus.mockResolvedValue(status({ chargeCodes: 1, employeesWithAccess: 0 }));
    m = await mount(<SetupWizardClient initialStatus={status({ chargeCodes: 0 })} />);
    expect(stepButton('Charge codes').getAttribute('data-progress')).toBe('true');
    await click(buttonByText('Refresh status'));
    await wait();
    expect(actions.getSetupStatus).toHaveBeenCalledTimes(1);
    expect(actions.getSetupAccessGaps).toHaveBeenCalledTimes(1);
    expect(stepButton('Charge code access').getAttribute('data-progress')).toBe('true');
  });

  it('after a refresh, the completion screen names the refreshed gaps (not stale ones)', async () => {
    actions.getSetupStatus.mockResolvedValue(status({ chargeCodes: 1, employeesWithAccess: 1 }));
    actions.getSetupAccessGaps.mockResolvedValue({ missingCount: 2, names: ['Bea New', 'Cal New'] });
    m = await mount(<SetupWizardClient initialStatus={status({ chargeCodes: 0 })} initialGaps={{ missingCount: 1, names: ['Old Name'] }} />);
    await click(buttonByText('Refresh status'));
    await wait();
    const gaps = m.container.querySelector('[data-testid="setup-access-gaps"]')!;
    expect(gaps.textContent).toContain('2 employees have no direct charge code yet and will see only indirect and leave rows: Bea New, Cal New.');
    expect(gaps.textContent).not.toContain('Old Name');
  });

  it('a refresh failure → the toast, and nothing changes', async () => {
    actions.getSetupStatus.mockRejectedValue(new Error('boom'));
    m = await mount(<SetupWizardClient initialStatus={status({ chargeCodes: 0 })} />);
    await click(buttonByText('Refresh status'));
    await wait();
    expect(actions.notify).toHaveBeenCalledWith(expect.objectContaining({ message: "Couldn't refresh setup status." }));
    expect(stepButton('Charge codes').getAttribute('data-progress')).toBe('true');
  });

  it('L8: one missing employee → "1 employee has no direct charge code yet…" (singular)', async () => {
    m = await mount(<SetupWizardClient initialStatus={status({ chargeCodes: 1, employees: 3, employeesWithAccess: 2 })} initialGaps={{ missingCount: 1, names: ['Dee Solo'] }} />);
    expect(m.container.querySelector('[data-testid="setup-access-gaps"]')!.textContent)
      .toContain('1 employee has no direct charge code yet and will see only indirect and leave rows: Dee Solo.');
  });

  it('the completion screen names the missing employees, then "and N more" past 20, with "Assign charge codes"', async () => {
    const names = Array.from({ length: 20 }, (_, i) => `Person ${String(i + 1).padStart(2, '0')}`);
    m = await mount(<SetupWizardClient initialStatus={status({ chargeCodes: 1, employees: 30, employeesWithAccess: 7 })} initialGaps={{ missingCount: 23, names }} />);
    const gaps = m.container.querySelector('[data-testid="setup-access-gaps"]')!;
    expect(gaps.textContent).toContain(`23 employees have no direct charge code yet and will see only indirect and leave rows: ${names.join(', ')} and 3 more.`);
    expect([...gaps.querySelectorAll('a')].find((a) => a.textContent === 'Assign charge codes')!.getAttribute('href')).toBe('/admin/assignments');
  });
});
