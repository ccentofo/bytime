// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';

/**
 * feature-plan-ux-navigation-home.md §4.4 / T20: on Profile → Notifications the supervisors-only switch is hidden for
 * employees and shown for supervisors (UI only).
 */

vi.mock('@/server/actions/notifications', () => ({ updateNotificationPreferences: vi.fn() }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));
vi.mock('server-only', () => ({}));

import { NotificationsClient } from '@/app/(app)/profile/notifications/NotificationsClient';
import { installDomStubs, mount, unmount, type Mounted } from '../helpers/dom';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { EXPECTED_SUBMITTER_ROLES } from '@/lib/submitter-roles';
import { EXPECTED_SUBMITTER_ROLES as SERVER_ROLES } from '@/server/internal/team-period-status';

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
 * feature-plan-launch-hardening.md H1 / Q1 / Q2 (T4): no daily switch for anyone. SWEEP-FINDINGS.md A3-D7 (the product
 * owner's decision 2, carried to this page by the lead): everyone the reminder crons email (EXPECTED_SUBMITTER_ROLES:
 * employees and supervisors) sees the always-on line and the deadline switch; admins see no reminder section at all.
 */
describe('Notifications page: reminders (T4, A3-D7)', () => {
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

  it('supervisor (A3-D7): the always-on line and the deadline switch, plus the supervisors-only switch', async () => {
    m = await mount(<NotificationsClient initialPrefs={PREFS} userRole="supervisor" />);
    const text = m.container.textContent ?? '';
    expect(text).not.toContain(DAILY);
    for (const present of [LINE, DEADLINE, SECTION, SWITCH]) expect(text).toContain(present);
    expect(m.container.querySelectorAll('input[type="checkbox"]')).toHaveLength(4); // submitted, approved, returned, deadline
  });

  it('admin: no daily switch, no deadline switch, no line, no reminder section', async () => {
    m = await mount(<NotificationsClient initialPrefs={PREFS} userRole="admin" />);
    const text = m.container.textContent ?? '';
    for (const absent of [DAILY, LINE, DEADLINE, SECTION]) expect(text, absent).not.toContain(absent);
    expect(m.container.querySelectorAll('input[type="checkbox"]')).toHaveLength(3); // submitted, approved, returned
  });

  it('the page and the reminder crons agree on who counts: the section shows exactly for EXPECTED_SUBMITTER_ROLES', async () => {
    for (const role of ['employee', 'supervisor', 'admin']) {
      m = await mount(<NotificationsClient initialPrefs={PREFS} userRole={role} />);
      expect(m.container.textContent?.includes(DEADLINE), role).toBe((EXPECTED_SUBMITTER_ROLES as readonly string[]).includes(role));
      unmount(m);
      m = undefined;
    }
    // ONE rule: both crons and this page read the same client-safe constant, and the server readers re-export it.
    const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), 'utf8');
    for (const cron of ['src/app/api/cron/daily-reminder/route.ts', 'src/app/api/cron/submission-deadline/route.ts']) {
      expect(read(cron), cron).toContain("import { EXPECTED_SUBMITTER_ROLES } from '@/lib/submitter-roles';");
      expect(read(cron), cron).toContain('inArray(users.role, [...EXPECTED_SUBMITTER_ROLES])');
      expect(read(cron), cron).not.toMatch(/eq\(users\.role, 'employee'\)/);
    }
    expect(read('src/app/(app)/profile/notifications/NotificationsClient.tsx')).toContain('{isExpectedSubmitter(userRole) && <>');
    expect(SERVER_ROLES).toBe(EXPECTED_SUBMITTER_ROLES);
  });
});
