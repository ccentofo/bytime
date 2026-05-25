'use client';

import { useState, useTransition } from 'react';
import {
  Title,
  Paper,
  Stack,
  Switch,
  Text,
  Group,
  Divider,
  Alert,
} from '@mantine/core';
import { IconBell, IconCheck } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { updateNotificationPreferences, type NotificationPrefs } from '@/server/actions/notifications';

type Props = {
  userId: string;
  initialPrefs: NotificationPrefs;
};

export function NotificationsClient({ userId, initialPrefs }: Props) {
  const [isPending, startTransition] = useTransition();
  const [prefs, setPrefs] = useState<NotificationPrefs>(initialPrefs);

  function handleToggle(key: keyof NotificationPrefs, value: boolean) {
    const updated = { ...prefs, [key]: value };
    setPrefs(updated);

    startTransition(async () => {
      await updateNotificationPreferences(userId, { [key]: value });
      notifications.show({
        title: 'Preferences Saved',
        message: 'Your notification settings have been updated.',
        color: 'green',
        icon: <IconCheck size={16} />,
      });
    });
  }

  return (
    <>
      <Title order={2} mb="lg">Notification Settings</Title>

      <Paper withBorder p="lg" radius="md" maw={600}>
        <Group mb="md">
          <IconBell size={20} />
          <Title order={4}>Email Notifications</Title>
        </Group>

        <Text size="sm" c="dimmed" mb="lg">
          Configure which email notifications you receive. Changes are saved automatically.
        </Text>

        <Stack gap="md">
          <Divider label="Workflow Notifications" labelPosition="left" />

          <Switch
            label="Timesheet Submitted (Supervisors)"
            description="Receive an email when an employee submits their timesheet for review"
            checked={prefs.emailOnSubmit}
            onChange={(e) => handleToggle('emailOnSubmit', e.currentTarget.checked)}
            disabled={isPending}
          />

          <Switch
            label="Timesheet Approved"
            description="Receive an email when your timesheet is approved by a supervisor"
            checked={prefs.emailOnApprove}
            onChange={(e) => handleToggle('emailOnApprove', e.currentTarget.checked)}
            disabled={isPending}
          />

          <Switch
            label="Timesheet Returned for Corrections"
            description="Receive an email when your timesheet is rejected and needs corrections"
            checked={prefs.emailOnReject}
            onChange={(e) => handleToggle('emailOnReject', e.currentTarget.checked)}
            disabled={isPending}
          />

          <Divider label="Reminder Notifications" labelPosition="left" />

          <Switch
            label="Daily Time Entry Reminder"
            description="Receive a daily reminder (weekdays) if you haven't entered time for the day"
            checked={prefs.emailDailyReminder}
            onChange={(e) => handleToggle('emailDailyReminder', e.currentTarget.checked)}
            disabled={isPending}
          />

          <Switch
            label="Period Submission Deadline Reminder"
            description="Receive a reminder 2 days before and on the last day of each pay period if your timesheet is still in draft"
            checked={prefs.emailDeadlineReminder}
            onChange={(e) => handleToggle('emailDeadlineReminder', e.currentTarget.checked)}
            disabled={isPending}
          />
        </Stack>
      </Paper>
    </>
  );
}
