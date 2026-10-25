'use client';

import { useEffect, useState, useTransition } from 'react';
import {
  Container,
  Title,
  Text,
  Paper,
  Group,
  Stack,
  Radio,
  Select,
  Button,
  Alert,
  Badge,
  Modal,
} from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import { IconAlertCircle, IconCheck, IconClock } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { runAction } from '@/lib/run-action';
import { updatePayPeriodConfig, getValidScheduleChangeDates, type ConfigHistoryRow, type ScheduleChangeOptions, type UpdatePayPeriodConfigResult } from '@/server/actions/pay-period-config';
import { updateWorkspaceTimezone, updateWorkweekStartDay } from '@/server/actions/workspace-settings';
import type { PeriodConfig, PeriodType } from '@/lib/date-utils';
import { formatDate } from '@/lib/format';
import { dayOfWeek, isCalendarDate, type CalendarDate } from '@/lib/calendar-date';
import { PageHeader } from '@/components/ui/PageHeader';
import { WriteButton } from '@/components/shell/WorkspaceMode';

interface Props {
  initialConfig: PeriodConfig;
  pendingChange: ConfigHistoryRow | null;
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

const IMMEDIATE = 'immediate';
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const PERIOD_TYPE_OPTIONS = [
  { value: 'weekly', label: 'Weekly (7 days, Mon–Sun)' },
  { value: 'biweekly', label: 'Bi-Weekly (14 days)' },
  { value: 'semimonthly', label: 'Semi-Monthly (1st–15th, 16th–end) — Default' },
  { value: 'monthly', label: 'Monthly (full calendar month)' },
];

const WEEK_START_OPTIONS = [
  { value: '0', label: 'Sunday' },
  { value: '1', label: 'Monday' },
];

const PERIOD_TYPE_LABELS: Record<string, string> = {
  weekly: 'Weekly',
  biweekly: 'Bi-Weekly',
  semimonthly: 'Semi-Monthly',
  monthly: 'Monthly',
};

export function SettingsClient({ initialConfig, pendingChange, initialTimezone, initialWorkweekStartDay }: Props) {
  const [periodType, setPeriodType] = useState<PeriodType>(initialConfig.periodType);
  const [anchorDate, setAnchorDate] = useState<CalendarDate | null>(initialConfig.anchorDate);
  const [weekStartDay, setWeekStartDay] = useState<string>(String(initialConfig.weekStartDay));
  const [isPending, startTransition] = useTransition();
  const [scheduledEffectiveFrom, setScheduledEffectiveFrom] = useState<CalendarDate | null>(
    pendingChange ? pendingChange.effectiveFrom : null
  );
  const [scheduledPeriodType, setScheduledPeriodType] = useState<PeriodType | null>(
    pendingChange ? pendingChange.periodType : null
  );

  // §0.9: effective_from must be a boundary common to both the current and the new schedule —
  // the server computes and offers the valid choices; the client never picks one out of thin air.
  const [changeOptions, setChangeOptions] = useState<ScheduleChangeOptions | null>(null);
  const [selectedEffectiveFrom, setSelectedEffectiveFrom] = useState<string | null>(null);
  const [loadingOptions, setLoadingOptions] = useState(false);

  useEffect(() => {
    if (!anchorDate) {
      setChangeOptions(null);
      setSelectedEffectiveFrom(null);
      return;
    }
    let cancelled = false;
    setLoadingOptions(true);
    setSelectedEffectiveFrom(null);
    getValidScheduleChangeDates({ periodType, anchorDate, weekStartDay: parseInt(weekStartDay, 10) })
      .then((options) => {
        if (cancelled) return;
        setChangeOptions(options);
        setSelectedEffectiveFrom(options.immediate ? IMMEDIATE : (options.dates[0] ?? null));
      })
      .catch((error) => {
        if (!cancelled) setChangeOptions({ immediate: false, dates: [], problem: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        if (!cancelled) setLoadingOptions(false);
      });
    return () => {
      cancelled = true;
    };
  }, [periodType, anchorDate, weekStartDay]);

  const [timezone, setTimezone] = useState<string | null>(initialTimezone);
  const [savedTimezone, setSavedTimezone] = useState<string>(initialTimezone);
  const [isTimezonePending, startTimezoneTransition] = useTransition();

  function handleSaveTimezone() {
    if (!timezone) return;
    startTimezoneTransition(async () => {
      const result = await runAction(updateWorkspaceTimezone(timezone), { errorTitle: 'Save failed' });
      if (!result.ok) return;
      const stored = result.data;
      setSavedTimezone(stored);
      setTimezone(stored);
      notifications.show({
        title: 'Workspace timezone updated',
        message: `"Today" and every late/future-date rule now use ${stored}.`,
        color: 'success',
        icon: <IconCheck size={16} />,
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
      notifications.show({ title: 'Workweek start day saved', message: `FLSA workweeks now start on ${DAY_NAMES[result.data]}.`, color: 'success', icon: <IconCheck size={16} /> });
    });
  }

  async function handleSave() {
    if (!anchorDate) {
      notifications.show({ title: 'Anchor date required', message: 'Please select an anchor date.', color: 'warning' });
      return;
    }
    if (!selectedEffectiveFrom) {
      notifications.show({ title: 'Effective date required', message: 'Select when the new schedule takes effect.', color: 'warning' });
      return;
    }

    startTransition(async () => {
      const outcome = await runAction(updatePayPeriodConfig({
        periodType,
        anchorDate,
        weekStartDay: parseInt(weekStartDay, 10),
        effectiveFrom: selectedEffectiveFrom === IMMEDIATE ? null : (selectedEffectiveFrom as CalendarDate),
      }), { errorTitle: 'Save failed' });
      if (!outcome.ok) return;
      const result: UpdatePayPeriodConfigResult = outcome.data;
      setScheduledEffectiveFrom(result.effectiveFrom);
      setScheduledPeriodType(result.effectiveFrom ? periodType : null);
      notifications.show({
        title: 'Schedule change saved',
        message: result.effectiveFrom
          ? `Your new ${PERIOD_TYPE_LABELS[periodType]} schedule takes effect ${formatDate(result.effectiveFrom)}. Current and past periods are unchanged.`
          : `Your ${PERIOD_TYPE_LABELS[periodType]} schedule is now in effect.`,
        color: 'success',
        icon: <IconCheck size={16} />,
        autoClose: 8000,
      });
    });
  }

  const showAnchorDate = periodType === 'weekly' || periodType === 'biweekly';
  const effectiveFromChoices = [
    ...(changeOptions?.immediate ? [{ value: IMMEDIATE, label: 'Immediately (no timesheets entered yet)' }] : []),
    ...(changeOptions?.dates ?? []).map((d) => ({ value: d, label: formatDate(d) })),
  ];

  return (
    <Container size="md" py="xl">
      <PageHeader
        title="Settings"
        description="Workspace-wide configuration for timekeeping."
      />

      <Paper withBorder p="lg" radius="md" mb="xl">
        <Title order={4} mb="md">Workspace Timezone</Title>
        <Text size="sm" c="dimmed" mb="sm">
          Used to determine "today" for late-entry and future-date rules, pay-period boundaries,
          and timestamps on timesheets, emails, and the audit trail. Changing it affects every
          employee immediately.
        </Text>
        <Group align="flex-end">
          <Select
            data={timezoneOptions(timezone)}
            value={timezone}
            onChange={setTimezone}
            searchable
            allowDeselect={false}
            w={320}
          />
          <WriteButton onClick={handleSaveTimezone} loading={isTimezonePending} disabled={!timezone || timezone === savedTimezone}>
            Save Timezone
          </WriteButton>
        </Group>
      </Paper>

      <Paper withBorder p="lg" radius="md" mb="xl">
        <Title order={4} mb="md">Workweek (FLSA overtime)</Title>
        <Text size="sm" c="dimmed" mb="sm">
          The day your fixed 7-day workweek starts. Payroll export computes FLSA weekly overtime (hours worked over 40
          in a workweek) from it, and stays unavailable until it is set.
        </Text>
        <Group align="flex-end">
          <Select
            data={DAY_NAMES.map((d, i) => ({ value: String(i), label: d }))}
            value={workweekDay}
            onChange={setWorkweekDay}
            placeholder="Not set"
            allowDeselect={false}
            w={200}
            data-testid="workweek-start-day"
          />
          <WriteButton
            onClick={() => (savedWorkweekDay === null ? saveWorkweek() : setConfirmWorkweek(true))}
            loading={isWorkweekPending}
            disabled={workweekDay === null || parseInt(workweekDay, 10) === savedWorkweekDay}
          >
            Save Workweek
          </WriteButton>
        </Group>
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

      <Paper withBorder p="lg" radius="md" mb="xl">
        <Title order={4} mb="md">Pay Period Configuration</Title>

        {/* Pending change banner */}
        {scheduledEffectiveFrom && (
          <Alert icon={<IconClock size={16} />} color="signal" variant="light" mb="lg">
            <Group gap="xs">
              <Text size="sm">
                <strong>Scheduled change:</strong> Your new {PERIOD_TYPE_LABELS[scheduledPeriodType ?? periodType] ?? periodType} schedule
                takes effect <strong>{formatDate(scheduledEffectiveFrom)}</strong>.
                Current and past periods are unchanged.
              </Text>
              <Badge color="signal" variant="light" size="sm">Pending</Badge>
            </Group>
          </Alert>
        )}

        <Alert icon={<IconAlertCircle size={16} />} color="warning" variant="light" mb="lg">
          <Text size="sm">
            <strong>Future-effective only.</strong> Changes apply starting at a future date that's a
            period boundary under both your current and new schedule — the current period and all
            historical data are preserved. You cannot set a retroactive schedule.
          </Text>
        </Alert>

        <Stack gap="lg">
          <div>
            <Text fw={600} size="sm" mb="sm">Period Type</Text>
            <Radio.Group
              value={periodType}
              onChange={(val) => setPeriodType(val as PeriodType)}
            >
              <Stack gap="xs">
                {PERIOD_TYPE_OPTIONS.map((opt) => (
                  <Radio key={opt.value} value={opt.value} label={opt.label} />
                ))}
              </Stack>
            </Radio.Group>
          </div>

          {showAnchorDate && (
            <div>
              <Text fw={600} size="sm" mb="xs">Anchor Date</Text>
              <Text size="xs" c="dimmed" mb="sm">
                {periodType === 'biweekly'
                  ? `A ${DAY_NAMES[parseInt(weekStartDay, 10)]} that marks the start of a bi-weekly period. All periods are calculated relative to this date.`
                  : `A ${DAY_NAMES[parseInt(weekStartDay, 10)]} that marks the start of a weekly period.`}
              </Text>
              <DatePickerInput
                value={anchorDate}
                onChange={(val) => setAnchorDate(val && isCalendarDate(val) ? val : null)}
                excludeDate={(d) => isCalendarDate(d) && dayOfWeek(d) !== parseInt(weekStartDay, 10)}
                placeholder="Select anchor date..."
                w={240}
              />
            </div>
          )}

          {(periodType === 'weekly' || periodType === 'biweekly') && (
            <div>
              <Text fw={600} size="sm" mb="xs">Week Start Day</Text>
              <Select
                data={WEEK_START_OPTIONS}
                value={weekStartDay}
                onChange={(val) => setWeekStartDay(val ?? '1')}
                w={200}
                allowDeselect={false}
              />
            </div>
          )}

          <div>
            <Text fw={600} size="sm" mb="xs">Effective From</Text>
            <Text size="xs" c="dimmed" mb="sm">
              Only dates that are a period boundary under both your current schedule and this new
              one are offered — this is what keeps every day in exactly one period across the
              change.
            </Text>
            <Select
              data={effectiveFromChoices}
              value={selectedEffectiveFrom}
              onChange={setSelectedEffectiveFrom}
              placeholder={loadingOptions ? 'Finding valid dates…' : effectiveFromChoices.length === 0 ? 'No valid date' : 'Select effective date...'}
              disabled={loadingOptions || effectiveFromChoices.length === 0}
              w={320}
              allowDeselect={false}
            />
            {!loadingOptions && changeOptions?.problem && (
              <Text size="xs" c="red" mt="xs">{changeOptions.problem}</Text>
            )}
          </div>

          <Group>
            <WriteButton onClick={handleSave} loading={isPending} disabled={!selectedEffectiveFrom}>
              Save Schedule Change
            </WriteButton>
          </Group>

          <Text size="xs" c="dimmed">
            You can update this setting again before it takes effect — your most recent save
            replaces any pending change.
          </Text>
        </Stack>
      </Paper>
    </Container>
  );
}
