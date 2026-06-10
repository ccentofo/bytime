'use client';

import { useState, useTransition } from 'react';
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
  ThemeIcon,
} from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import { IconSettings, IconAlertCircle, IconCheck } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { updatePayPeriodConfig } from '@/server/actions/pay-period-config';
import type { PeriodConfig, PeriodType } from '@/lib/date-utils';

interface Props {
  initialConfig: PeriodConfig;
}

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

export function SettingsClient({ initialConfig }: Props) {
  const [periodType, setPeriodType] = useState<PeriodType>(initialConfig.periodType);
  const [anchorDate, setAnchorDate] = useState<Date | null>(initialConfig.anchorDate);
  const [weekStartDay, setWeekStartDay] = useState<string>(String(initialConfig.weekStartDay));
  const [isPending, startTransition] = useTransition();

  async function handleSave() {
    if (!anchorDate) {
      notifications.show({ title: 'Anchor date required', message: 'Please select an anchor date.', color: 'yellow' });
      return;
    }

    startTransition(async () => {
      try {
        await updatePayPeriodConfig({
          periodType,
          anchorDate,
          weekStartDay: parseInt(weekStartDay, 10),
        });
        notifications.show({
          title: 'Settings saved',
          message: 'Pay period configuration updated. New periods will use the updated schedule.',
          color: 'green',
          icon: <IconCheck size={16} />,
        });
      } catch (error) {
        notifications.show({ title: 'Save failed', message: String(error), color: 'red' });
      }
    });
  }

  const showAnchorDate = periodType === 'weekly' || periodType === 'biweekly';

  return (
    <Container size="md" py="xl">
      <Group gap="sm" mb="xl">
        <ThemeIcon size="lg" color="gray" variant="light" radius="md">
          <IconSettings size={20} />
        </ThemeIcon>
        <Title order={2}>Settings</Title>
      </Group>

      <Paper withBorder p="lg" radius="md" mb="xl">
        <Title order={4} mb="md">Pay Period Configuration</Title>

        <Alert icon={<IconAlertCircle size={16} />} color="yellow" variant="light" mb="lg">
          <Text size="sm">
            <strong>Warning:</strong> Changing the pay period type only affects future periods.
            Historical timesheet data is preserved and remains valid.
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
                onChange={(val) => setAnchorDate(val ? new Date(val) : null)}
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

          <Group>
            <Button
              onClick={handleSave}
              loading={isPending}
            >
              Save Settings
            </Button>
          </Group>
        </Stack>
      </Paper>
    </Container>
  );
}
