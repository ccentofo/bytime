'use client';

import { useState, useTransition } from 'react';
import {
  Title,
  Paper,
  Stack,
  Group,
  Text,
  Badge,
  PasswordInput,
  Button,
  Alert,
  Divider,
} from '@mantine/core';
import { IconKey, IconCheck, IconAlertCircle, IconUser } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { changePassword } from '@/server/actions/password';
import dayjs from 'dayjs';

type Props = {
  userId: string;
  fullName: string;
  email: string;
  role: string;
  passwordInfo: {
    hasPassword: boolean;
    lastChangedAt: Date | null;
  };
};

const ROLE_COLORS: Record<string, string> = {
  admin: 'red',
  supervisor: 'blue',
  employee: 'green',
};

export function ProfileClient({ userId, fullName, email, role, passwordInfo }: Props) {
  const [isPending, startTransition] = useTransition();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  function handleChangePassword() {
    setError(null);
    setSuccess(false);

    // Client-side validation
    if (!currentPassword) {
      setError('Please enter your current password.');
      return;
    }
    if (!newPassword) {
      setError('Please enter a new password.');
      return;
    }
    if (newPassword.length < 8) {
      setError('New password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('New passwords do not match.');
      return;
    }

    startTransition(async () => {
      const result = await changePassword({
        userId,
        currentPassword,
        newPassword,
      });

      if (result.success) {
        setSuccess(true);
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
        notifications.show({
          title: 'Password Changed',
          message: 'Your password has been updated successfully.',
          color: 'green',
          icon: <IconCheck size={16} />,
        });
      } else {
        setError(result.error ?? 'Failed to change password.');
      }
    });
  }

  return (
    <>
      <Title order={2} mb="lg">My Profile</Title>

      {/* User Info Card */}
      <Paper withBorder p="lg" radius="md" mb="xl">
        <Group>
          <IconUser size={24} />
          <div>
            <Text fw={600} size="lg">{fullName}</Text>
            <Text size="sm" c="dimmed">{email}</Text>
          </div>
          <Badge color={ROLE_COLORS[role] ?? 'gray'} variant="light" size="lg" ml="auto">
            {role.charAt(0).toUpperCase() + role.slice(1)}
          </Badge>
        </Group>
      </Paper>

      {/* Password Change Section */}
      <Paper withBorder p="lg" radius="md">
        <Group mb="md">
          <IconKey size={20} />
          <Title order={4}>Change Password</Title>
        </Group>

        {passwordInfo.lastChangedAt && (
          <Text size="xs" c="dimmed" mb="md">
            Last changed: {dayjs(passwordInfo.lastChangedAt).format('MMM D, YYYY h:mm A')}
          </Text>
        )}

        {!passwordInfo.hasPassword && (
          <Alert icon={<IconAlertCircle size={16} />} color="yellow" variant="light" mb="md">
            Your account does not have a password set. Contact your administrator.
          </Alert>
        )}

        {success && (
          <Alert icon={<IconCheck size={16} />} color="green" variant="light" mb="md">
            Your password has been changed successfully.
          </Alert>
        )}

        {error && (
          <Alert icon={<IconAlertCircle size={16} />} color="red" variant="light" mb="md">
            {error}
          </Alert>
        )}

        {passwordInfo.hasPassword && (
          <Stack gap="sm" maw={400}>
            <PasswordInput
              label="Current Password"
              placeholder="Enter your current password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.currentTarget.value)}
              required
            />
            <Divider label="New Password" labelPosition="left" />
            <PasswordInput
              label="New Password"
              placeholder="Minimum 8 characters"
              value={newPassword}
              onChange={(e) => setNewPassword(e.currentTarget.value)}
              required
            />
            <PasswordInput
              label="Confirm New Password"
              placeholder="Re-enter new password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.currentTarget.value)}
              required
              error={confirmPassword && newPassword !== confirmPassword ? 'Passwords do not match' : undefined}
            />
            <Button
              onClick={handleChangePassword}
              loading={isPending}
              disabled={!currentPassword || !newPassword || !confirmPassword}
              leftSection={<IconKey size={16} />}
              mt="sm"
            >
              Change Password
            </Button>
          </Stack>
        )}
      </Paper>
    </>
  );
}
