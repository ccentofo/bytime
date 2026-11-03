// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * feature-plan-ux-navigation-home.md §4.4 / T19: Settings → Workspace (timezone, workweek, export) and Settings → Pay
 * schedule are separate pages; the Workspace page never runs the pay-schedule hooks (no getValidScheduleChangeDates
 * call); both pages guard with requirePageRole('admin') first.
 */

const actions = vi.hoisted(() => ({
  getValidScheduleChangeDates: vi.fn(async () => ({ immediate: false, dates: ['2027-01-01'], problem: null })),
  updateWorkspaceTimezone: vi.fn<(...a: unknown[]) => Promise<unknown>>(async (tz) => ({ ok: true, data: tz })),
}));
vi.mock('@/server/actions/pay-period-config', () => ({ updatePayPeriodConfig: vi.fn(), getValidScheduleChangeDates: actions.getValidScheduleChangeDates }));
vi.mock('@/server/actions/workspace-settings', () => ({ updateWorkspaceTimezone: actions.updateWorkspaceTimezone, updateWorkweekStartDay: vi.fn() }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

import { WorkspaceSettingsClient } from '@/app/(app)/settings/workspace/WorkspaceSettingsClient';
import { PayScheduleClient } from '@/app/(app)/settings/pay-schedule/PayScheduleClient';
import { buttonByText, click, dialogTitled, installDomStubs, mount, unmount, wait, type Mounted } from '../helpers/dom';
import { notifications } from '@mantine/notifications';
import { stripComments } from '../helpers/source-scanner';

beforeAll(installDomStubs);
let m: Mounted | undefined;
afterEach(() => { unmount(m); m = undefined; vi.clearAllMocks(); });
const ROOT = path.resolve(__dirname, '../../..');
const text = () => m!.container.textContent ?? '';

describe('Settings pages (T19)', () => {
  it('Workspace: timezone, workweek and export; no pay-period section; never asks for schedule-change dates', async () => {
    m = await mount(<WorkspaceSettingsClient initialTimezone="America/New_York" initialWorkweekStartDay={1} />);
    await wait(30);
    expect(m.container.querySelector('h1')!.textContent).toBe('Workspace');
    expect(text()).toContain('Applies to everyone in your workspace.');
    expect(text()).toContain('Workspace Timezone');
    expect(text()).toContain('Workweek (FLSA overtime)');
    expect(text()).toContain('Export all workspace data');
    expect(text()).not.toContain('Pay Period Configuration');
    expect(actions.getValidScheduleChangeDates).not.toHaveBeenCalled();
  });

  it('Pay schedule: pay periods only', async () => {
    m = await mount(<PayScheduleClient initialConfig={{ periodType: 'semimonthly', anchorDate: '2026-01-01', weekStartDay: 1 } as never} pendingChange={null} />);
    await wait(30);
    expect(m.container.querySelector('h1')!.textContent).toBe('Pay schedule');
    expect(text()).toContain('Pay Period Configuration');
    expect(text()).not.toContain('Workspace Timezone');
    expect(text()).not.toContain('Export all workspace data');
    // C7: no dates are fetched while the form is the current schedule (nothing to schedule).
    expect(actions.getValidScheduleChangeDates).not.toHaveBeenCalled();
  });

  it('static: both pages call requirePageRole(\'admin\') first, fetch only their own data, and are titled Workspace / Pay schedule', () => {
    const page = (rel: string) => stripComments(readFileSync(path.join(ROOT, 'src/app/(app)/settings', rel, 'page.tsx'), 'utf8'));
    for (const [rel, title] of [['workspace', 'Workspace'], ['pay-schedule', 'Pay schedule']] as const) {
      const src = page(rel);
      const body = src.slice(src.indexOf('export default async function'));
      expect(body.indexOf('await requirePageRole(\'admin\');'), rel).toBeGreaterThan(-1);
      expect(body.indexOf('await requirePageRole(\'admin\');'), rel).toBeLessThan(body.indexOf('await Promise.all'));
      expect(src).toContain(`export const metadata: Metadata = { title: '${title}' };`);
    }
    expect(page('workspace')).not.toMatch(/getCurrentEffectiveConfig|getPendingConfigChange/);
    expect(page('pay-schedule')).not.toMatch(/getWorkspaceTimezoneSetting|getWorkweekStartDaySetting/);
  });
});

describe('Workspace timezone (feature-plan-ux-page-fixes.md C8, T-C8)', () => {
  const field = (text: string) => {
    const l = [...m!.container.querySelectorAll('label')].find((x) => x.textContent?.replace(/\s*\*\s*$/, '').trim() === text);
    return l ? document.getElementById(l.htmlFor) as HTMLInputElement : null;
  };
  const inDialog = (d: HTMLElement, label: string) => [...d.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement;
  async function chooseChicago() {
    m = await mount(<WorkspaceSettingsClient initialTimezone="America/New_York" initialWorkweekStartDay={1} />);
    await click(field('Timezone'));
    await click([...document.body.querySelectorAll('[role="option"]')].find((o) => o.textContent?.trim() === 'America/Chicago'));
  }

  it('both Selects are labelled', async () => {
    m = await mount(<WorkspaceSettingsClient initialTimezone="America/New_York" initialWorkweekStartDay={1} />);
    expect(field('Timezone')).not.toBeNull();
    expect(field('Workweek starts on')).not.toBeNull();
  });

  it('Save asks first: Cancel → nothing saved; Confirm → saved once, the confirm closes', async () => {
    await chooseChicago();
    await click(buttonByText('Save Timezone'));
    const confirm = dialogTitled('Change the workspace timezone?')!;
    expect(confirm.textContent).toContain('“Today” for every employee will follow America/Chicago instead of America/New_York. Late-entry and future-date rules, pay-period boundaries and timestamps change immediately.');
    expect(actions.updateWorkspaceTimezone).not.toHaveBeenCalled();
    await click(inDialog(confirm, 'Cancel'));
    expect(actions.updateWorkspaceTimezone).not.toHaveBeenCalled();
    await click(buttonByText('Save Timezone'));
    await click(inDialog(dialogTitled('Change the workspace timezone?')!, 'Change timezone'));
    await wait();
    expect(actions.updateWorkspaceTimezone).toHaveBeenCalledTimes(1);
    expect(actions.updateWorkspaceTimezone).toHaveBeenCalledWith('America/Chicago');
    expect(dialogTitled('Change the workspace timezone?')).toBeUndefined();
  });

  it('an error shows inside the confirm (not as a toast), and the confirm stays open', async () => {
    actions.updateWorkspaceTimezone.mockResolvedValueOnce({ ok: false, code: 'validation', error: 'Unknown timezone.' });
    await chooseChicago();
    await click(buttonByText('Save Timezone'));
    await click(inDialog(dialogTitled('Change the workspace timezone?')!, 'Change timezone'));
    await wait();
    expect(dialogTitled('Change the workspace timezone?')!.querySelector('[role="alert"]')!.textContent).toBe('Unknown timezone.');
    expect(notifications.show).not.toHaveBeenCalled();
  });
});
