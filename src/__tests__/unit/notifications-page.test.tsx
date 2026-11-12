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

const PREFS = { emailOnSubmit: true, emailOnApprove: true, emailOnReject: true, emailDeadlineReminder: true } as never;
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

/**
 * feature-plan-launch-hardening.md H1 / Q1 / Q2 (T4): no daily switch for anyone; employees see the always-on line and
 * the deadline switch; supervisors and admins see no reminder section at all.
 */
describe('Notifications page: reminders (T4)', () => {
  const DAILY = 'Daily Time Entry Reminder';
  const LINE = 'Daily time entry reminders are always on. You’ll get one on weekdays when you haven’t entered time.';
  const DEADLINE = 'Period Submission Deadline Reminder';
  const SECTION = 'Reminder Notifications';

  it('employee: no daily switch; the always-on line and the deadline switch', async () => {
    m = await mount(<NotificationsClient initialPrefs={PREFS} userRole="employee" />);
    const text = m.container.textContent ?? '';
    expect(text).not.toContain(DAILY);
    expect(text).toContain(LINE);
    expect(text).toContain(DEADLINE);
    expect(text).toContain(SECTION);
    expect(m.container.querySelectorAll('input[type="checkbox"]')).toHaveLength(3); // approved, returned, deadline
  });

  it('supervisor and admin: no daily switch, no deadline switch, no line, no reminder section', async () => {
    for (const role of ['supervisor', 'admin']) {
      m = await mount(<NotificationsClient initialPrefs={PREFS} userRole={role} />);
      const text = m.container.textContent ?? '';
      for (const absent of [DAILY, LINE, DEADLINE, SECTION]) expect(text, `${role}: ${absent}`).not.toContain(absent);
      expect(m.container.querySelectorAll('input[type="checkbox"]'), role).toHaveLength(3); // submitted, approved, returned
      unmount(m);
      m = undefined;
    }
  });
});
