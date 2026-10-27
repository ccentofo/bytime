// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';

/**
 * feature-plan-ux-navigation-home.md §4.4 / T20: on Profile → Notifications the supervisors-only switch is hidden for
 * employees and shown for supervisors (UI only).
 */

vi.mock('@/server/actions/notifications', () => ({ updateNotificationPreferences: vi.fn() }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

import { NotificationsClient } from '@/app/(app)/profile/notifications/NotificationsClient';
import { installDomStubs, mount, unmount, type Mounted } from '../helpers/dom';

beforeAll(installDomStubs);
let m: Mounted | undefined;
afterEach(() => { unmount(m); m = undefined; });

const PREFS = { emailOnSubmit: true, emailOnApprove: true, emailOnReject: true, emailReminders: true } as never;
const SWITCH = 'Timesheet Submitted (Supervisors)';

describe('Notifications page (T20)', () => {
  it('employee: no supervisors-only switch', async () => {
    m = await mount(<NotificationsClient initialPrefs={PREFS} userRole="employee" />);
    expect(m.container.textContent).not.toContain(SWITCH);
    expect(m.container.textContent).toContain('Timesheet Approved');
  });

  it('supervisor (and admin): the switch is shown', async () => {
    for (const role of ['supervisor', 'admin']) {
      m = await mount(<NotificationsClient initialPrefs={PREFS} userRole={role} />);
      expect(m.container.textContent, role).toContain(SWITCH);
      unmount(m);
      m = undefined;
    }
  });
});
