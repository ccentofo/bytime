'use client';

import { useState, useTransition } from 'react';
import { Container, Title, Text, Paper, Group, Select, Button, Modal, Loader } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { runAction } from '@/lib/run-action';
import { updateWorkspaceTimezone, updateWorkweekStartDay } from '@/server/actions/workspace-settings';
import { PageHeader } from '@/components/ui/PageHeader';
import { WriteButton } from '@/components/shell/WorkspaceMode';
import { Icons, ICON_SIZE } from '@/components/ui/icons';
import { ConfirmModal } from '@/components/ui/ConfirmModal';

/**
 * Settings → Workspace (feature-plan-ux-navigation-home.md §4.4): timezone, FLSA workweek and the data export — split
 * out of the old combined Settings page so its pay-schedule hooks (and their server call) don't run here.
 */
interface Props {
  initialTimezone: string;
  /** certified-outputs C7: FLSA workweek start day (0 = Sunday), null while unset. */
  initialWorkweekStartDay: number | null;
}

const BROWSER_TIMEZONES: string[] = typeof Intl.supportedValuesOf === 'function'
  ? Intl.supportedValuesOf('timeZone')
  : [];

/** The browser's zone list, always including `current`: browsers disagree on names
 *  (e.g. Asia/Calcutta vs Asia/Kolkata) and some omit UTC, and a Select whose value isn't
 *  among its options renders blank. */
function timezoneOptions(current: string | null) {
  const zones = current && !BROWSER_TIMEZONES.includes(current) ? [current, ...BROWSER_TIMEZONES] : BROWSER_TIMEZONES;
  return zones.map((tz) => ({ value: tz, label: tz }));
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function WorkspaceSettingsClient({ initialTimezone, initialWorkweekStartDay }: Props) {
  const [timezone, setTimezone] = useState<string | null>(initialTimezone);
  const [savedTimezone, setSavedTimezone] = useState<string>(initialTimezone);
  const [isTimezonePending, startTimezoneTransition] = useTransition();
  // feature-plan-ux-page-fixes.md C8: a timezone change asks first; its error shows inside the confirm.
  const [confirmTimezone, setConfirmTimezone] = useState(false);
  const [timezoneError, setTimezoneError] = useState<string | null>(null);

  function handleSaveTimezone() {
    if (!timezone) return;
    startTimezoneTransition(async () => {
      const result = await runAction(updateWorkspaceTimezone(timezone), { silent: true });
      if (!result.ok) {
        setTimezoneError(result.error);
        return;
      }
      setConfirmTimezone(false);
      const stored = result.data;
      setSavedTimezone(stored);
      setTimezone(stored);
      notifications.show({
        title: 'Workspace timezone updated',
        message: `"Today" and every late/future-date rule now use ${stored}.`,
        color: 'success',
        icon: <Icons.statusSuccess size={ICON_SIZE.button} />,
      });
    });
  }

  const [workweekDay, setWorkweekDay] = useState<string | null>(initialWorkweekStartDay === null ? null : String(initialWorkweekStartDay));
  const [savedWorkweekDay, setSavedWorkweekDay] = useState<number | null>(initialWorkweekStartDay);
  const [confirmWorkweek, setConfirmWorkweek] = useState(false);
  const [isWorkweekPending, startWorkweekTransition] = useTransition();

  function saveWorkweek() {
    if (workweekDay === null) return;
    setConfirmWorkweek(false);
    startWorkweekTransition(async () => {
      const result = await runAction(updateWorkweekStartDay(parseInt(workweekDay, 10)), { errorTitle: 'Save failed' });
      if (!result.ok) return;
      setSavedWorkweekDay(result.data);
      notifications.show({ title: 'Workweek start day saved', message: `FLSA workweeks now start on ${DAY_NAMES[result.data]}.`, color: 'success', icon: <Icons.statusSuccess size={ICON_SIZE.button} /> });
    });
  }

  // UX-4A-AUDIT.md M3: the Save buttons are aria-disabled with a visible reason, never `disabled` (nor Mantine `loading`,
  // which sets it): after a confirm, the Modal returns focus to its button, and a disabled one drops focus to <body>.
  const timezoneUnchanged = !timezone || timezone === savedTimezone;
  const canSaveTimezone = !timezoneUnchanged && !isTimezonePending;
  const workweekUnchanged = workweekDay === null || parseInt(workweekDay, 10) === savedWorkweekDay;
  const canSaveWorkweek = !workweekUnchanged && !isWorkweekPending;

  return (
    <Container size="md" py="xl">
      <PageHeader title="Workspace" description="Applies to everyone in your workspace." />

      <Paper withBorder p="lg" radius="md" mb="xl">
        <Title order={4} mb="md">Workspace Timezone</Title>
        <Text size="sm" c="dimmed" mb="sm">
          Used to determine "today" for late-entry and future-date rules, pay-period boundaries,
          and timestamps on timesheets, emails, and the audit trail. Changing it affects every
          employee immediately.
        </Text>
        <Group align="flex-end">
          <Select
            label="Timezone"
            data={timezoneOptions(timezone)}
            value={timezone}
            onChange={setTimezone}
            searchable
            allowDeselect={false}
            w={320}
          />
          <WriteButton
            onClick={() => { if (canSaveTimezone) { setTimezoneError(null); setConfirmTimezone(true); } }}
            aria-disabled={!canSaveTimezone || undefined}
            data-disabled={!canSaveTimezone || undefined}
            aria-describedby={timezoneUnchanged ? 'timezone-save-why' : undefined}
            leftSection={isTimezonePending ? <Loader size={16} aria-hidden="true" /> : undefined}
          >
            Save Timezone
          </WriteButton>
        </Group>
        {timezoneUnchanged && <Text id="timezone-save-why" size="xs" c="dimmed" mt={4}>Choose a different timezone to save.</Text>}
        <ConfirmModal
          opened={confirmTimezone}
          tone="neutral"
          title="Change the workspace timezone?"
          message={`“Today” for every employee will follow ${timezone} instead of ${savedTimezone}. Late-entry and future-date rules, pay-period boundaries and timestamps change immediately.`}
          confirmLabel="Change timezone"
          loading={isTimezonePending}
          error={timezoneError}
          onConfirm={handleSaveTimezone}
          onCancel={() => setConfirmTimezone(false)}
        />
      </Paper>

      <Paper withBorder p="lg" radius="md" mb="xl">
        <Title order={4} mb="md">Workweek (FLSA overtime)</Title>
        <Text size="sm" c="dimmed" mb="sm">
          The day your fixed 7-day workweek starts. Payroll export computes FLSA weekly overtime (hours worked over 40
          in a workweek) from it, and stays unavailable until it is set.
        </Text>
        <Group align="flex-end">
          <Select
            label="Workweek starts on"
            data={DAY_NAMES.map((d, i) => ({ value: String(i), label: d }))}
            value={workweekDay}
            onChange={setWorkweekDay}
            placeholder="Not set"
            allowDeselect={false}
            w={200}
            data-testid="workweek-start-day"
          />
          <WriteButton
            onClick={() => { if (!canSaveWorkweek) return; return savedWorkweekDay === null ? saveWorkweek() : setConfirmWorkweek(true); }}
            aria-disabled={!canSaveWorkweek || undefined}
            data-disabled={!canSaveWorkweek || undefined}
            aria-describedby={workweekUnchanged ? 'workweek-save-why' : undefined}
            leftSection={isWorkweekPending ? <Loader size={16} aria-hidden="true" /> : undefined}
          >
            Save Workweek
          </WriteButton>
        </Group>
        {workweekUnchanged && <Text id="workweek-save-why" size="xs" c="dimmed" mt={4}>Choose a different day to save.</Text>}
        <Modal opened={confirmWorkweek} onClose={() => setConfirmWorkweek(false)} title="Change the workweek?">
          <Text size="sm" mb="md" data-testid="workweek-change-warning">
            Federal law (FLSA, 29 CFR 778.105) requires a fixed workweek. Change it only for a permanent business reason
            — never to avoid overtime. The change is recorded in the admin change log.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setConfirmWorkweek(false)}>Cancel</Button>
            <Button color="red" onClick={saveWorkweek}>Change workweek</Button>
          </Group>
        </Modal>
      </Paper>

      <Paper withBorder p="lg" radius="md" mb="xl">
        <Title order={4} mb="md">Export Workspace Data</Title>
        <Text size="sm" c="dimmed" mb="sm">
          Download every record in your workspace — employees, contracts, CLINs/SLINs, charge
          codes, and every timesheet revision — as a zip of CSV files, with a data dictionary and
          a manifest. Available to admins at any time, including while read-only or suspended.
        </Text>
        <Button component="a" href="/api/export/workspace" variant="default">
          Export all workspace data
        </Button>
      </Paper>

    </Container>
  );
}
