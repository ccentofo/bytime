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
} from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import { IconAlertCircle, IconCheck, IconClock } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { updatePayPeriodConfig, getValidScheduleChangeDates, type ConfigHistoryRow, type UpdatePayPeriodConfigResult } from '@/server/actions/pay-period-config';
import { updateWorkspaceTimezone } from '@/server/actions/workspace-settings';
import type { PeriodConfig, PeriodType } from '@/lib/date-utils';
import { formatDate } from '@/lib/format';
import { isCalendarDate, type CalendarDate } from '@/lib/calendar-date';
import { PageHeader } from '@/components/ui/PageHeader';

interface Props {
  initialConfig: PeriodConfig;
  pendingChange: ConfigHistoryRow | null;
  initialTimezone: string;
}

const TIMEZONE_OPTIONS = typeof Intl.supportedValuesOf === 'function'
  ? Intl.supportedValuesOf('timeZone').map((tz) => ({ value: tz, label: tz }))
  : [];

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

export function SettingsClient({ initialConfig, pendingChange, initialTimezone }: Props) {
  const [periodType, setPeriodType] = useState<PeriodType>(initialConfig.periodType);
  const [anchorDate, setAnchorDate] = useState<CalendarDate | null>(initialConfig.anchorDate);
  const [weekStartDay, setWeekStartDay] = useState<string>(String(initialConfig.weekStartDay));
  const [isPending, startTransition] = useTransition();
  const [scheduledEffectiveFrom, setScheduledEffectiveFrom] = useState<CalendarDate | null>(
    pendingChange ? pendingChange.effectiveFrom : null
  );

  // §0.9: effective_from must be a boundary common to both the current and the new schedule —
  // the server computes and offers the valid choices; the client never picks one out of thin air.
  const [effectiveFromOptions, setEffectiveFromOptions] = useState<CalendarDate[]>([]);
  const [selectedEffectiveFrom, setSelectedEffectiveFrom] = useState<CalendarDate | null>(null);
  const [loadingOptions, setLoadingOptions] = useState(false);

  useEffect(() => {
    if (!anchorDate) {
      setEffectiveFromOptions([]);
      setSelectedEffectiveFrom(null);
      return;
    }
    let cancelled = false;
    setLoadingOptions(true);
    setSelectedEffectiveFrom(null);
    getValidScheduleChangeDates({ periodType, anchorDate, weekStartDay: parseInt(weekStartDay, 10) })
      .then((dates) => {
        if (cancelled) return;
        setEffectiveFromOptions(dates);
        setSelectedEffectiveFrom(dates[0] ?? null);
      })
      .catch(() => {
        if (!cancelled) setEffectiveFromOptions([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingOptions(false);
      });
    return () => {
      cancelled = true;
    };
  }, [periodType, anchorDate, weekStartDay]);

  const [timezone, setTimezone] = useState<string | null>(initialTimezone);
  const [isTimezonePending, startTimezoneTransition] = useTransition();

  function handleSaveTimezone() {
    if (!timezone) return;
    startTimezoneTransition(async () => {
      try {
        await updateWorkspaceTimezone(timezone);
        notifications.show({
          title: 'Workspace timezone updated',
          message: `"Today" and every late/future-date rule now use ${timezone}.`,
          color: 'success',
          icon: <IconCheck size={16} />,
        });
      } catch (error) {
        notifications.show({ title: 'Save failed', message: String(error), color: 'red' });
      }
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
      try {
        const result: UpdatePayPeriodConfigResult = await updatePayPeriodConfig({
          periodType,
          anchorDate,
          weekStartDay: parseInt(weekStartDay, 10),
          effectiveFrom: selectedEffectiveFrom,
        });
        setScheduledEffectiveFrom(result.effectiveFrom);
        notifications.show({
          title: 'Schedule change saved',
          message: `Your new ${PERIOD_TYPE_LABELS[periodType]} schedule takes effect ${formatDate(result.effectiveFrom)}. Current and past periods are unchanged.`,
          color: 'success',
          icon: <IconCheck size={16} />,
          autoClose: 8000,
        });
      } catch (error) {
        notifications.show({ title: 'Save failed', message: String(error), color: 'red' });
      }
    });
  }

  const showAnchorDate = periodType === 'weekly' || periodType === 'biweekly';

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
            data={TIMEZONE_OPTIONS}
            value={timezone}
            onChange={setTimezone}
            searchable
            allowDeselect={false}
            w={320}
          />
          <Button onClick={handleSaveTimezone} loading={isTimezonePending} disabled={timezone === initialTimezone}>
            Save Timezone
          </Button>
        </Group>
      </Paper>

      <Paper withBorder p="lg" radius="md" mb="xl">
        <Title order={4} mb="md">Pay Period Configuration</Title>

        {/* Pending change banner */}
        {scheduledEffectiveFrom && (
          <Alert icon={<IconClock size={16} />} color="signal" variant="light" mb="lg">
            <Group gap="xs">
              <Text size="sm">
                <strong>Scheduled change:</strong> Your new {PERIOD_TYPE_LABELS[periodType] ?? periodType} schedule
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
                  ? 'A Monday that marks the start of a bi-weekly period. All periods are calculated relative to this date.'
                  : 'A Monday that marks the start of a weekly period.'}
              </Text>
              <DatePickerInput
                value={anchorDate}
                onChange={(val) => setAnchorDate(val && isCalendarDate(val) ? val : null)}
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
              data={effectiveFromOptions.map((d) => ({ value: d, label: formatDate(d) }))}
              value={selectedEffectiveFrom}
              onChange={(val) => setSelectedEffectiveFrom(val as CalendarDate | null)}
              placeholder={loadingOptions ? 'Finding valid dates…' : effectiveFromOptions.length === 0 ? 'No valid date found — try a different anchor' : 'Select effective date...'}
              disabled={loadingOptions || effectiveFromOptions.length === 0}
              w={260}
              allowDeselect={false}
            />
          </div>

          <Group>
            <Button onClick={handleSave} loading={isPending} disabled={!selectedEffectiveFrom}>
              Save Schedule Change
            </Button>
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
