'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  Center,
  Stack,
  Paper,
  Title,
  PasswordInput,
  Button,
  Alert,
  Text,
  Anchor,
  Avatar,
  Loader,
} from '@mantine/core';
import { IconCheck, IconAlertCircle, IconArrowLeft, IconLock } from '@tabler/icons-react';
import { verifyResetToken, resetPassword } from '@/server/actions/password-reset';

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const email = searchParams.get('email') ?? '';

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [verifying, setVerifying] = useState(true);
  const [tokenValid, setTokenValid] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    async function verify() {
      if (!token || !email) {
        setTokenValid(false);
        setVerifying(false);
        return;
      }
      const result = await verifyResetToken(email, token);
      setTokenValid(result.valid);
      setVerifying(false);
    }
    verify();
  }, [token, email]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }

    setLoading(true);

    const result = await resetPassword({ email, token, newPassword: password });

    setLoading(false);

    if (result.success) {
      setSuccess(true);
    } else {
      setError(result.error ?? 'An error occurred. Please try again.');
    }
  }

  if (verifying) {
    return (
      <Stack align="center" gap="md">
        <Loader size="lg" />
        <Text c="dimmed">Verifying reset link...</Text>
      </Stack>
    );
  }

  return (
    <Paper shadow="md" p="xl" radius="md" w={420} withBorder>
      <Stack align="center" mb="lg">
        <Avatar src="/logo.png" size="lg" radius="sm" />
        <Title order={2}>Set New Password</Title>
      </Stack>

      {!tokenValid && !success ? (
        <Stack align="center" gap="md">
          <Alert icon={<IconAlertCircle size={16} />} color="red" variant="light">
            This password reset link is invalid or has expired. Please request a new one.
          </Alert>
          <Anchor href="/forgot-password" size="sm">
            Request a New Reset Link
          </Anchor>
        </Stack>
      ) : success ? (
        <Stack align="center" gap="md">
          <Alert icon={<IconCheck size={16} />} color="green" variant="light">
            Your password has been reset successfully! You can now sign in with your new password.
          </Alert>
          <Button component="a" href="/login" fullWidth>
            Sign In
          </Button>
        </Stack>
      ) : (
        <form onSubmit={handleSubmit}>
          <Stack>
            {error && (
              <Alert icon={<IconAlertCircle size={16} />} color="red" variant="light">
                {error}
              </Alert>
            )}
            <Text size="sm" c="dimmed">
              Resetting password for <strong>{decodeURIComponent(email)}</strong>
            </Text>
            <PasswordInput
              label="New Password"
              placeholder="At least 8 characters"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              autoFocus
            />
            <PasswordInput
              label="Confirm New Password"
              placeholder="Enter password again"
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
            />
            <Button
              type="submit"
              fullWidth
              loading={loading}
              leftSection={<IconLock size={16} />}
            >
              Reset Password
            </Button>
            <Anchor href="/login" size="sm" ta="center">
              <IconArrowLeft size={14} style={{ marginRight: 4, verticalAlign: 'middle' }} />
              Back to Sign In
            </Anchor>
          </Stack>
        </form>
      )}
    </Paper>
  );
}

export default function ResetPasswordPage() {
  return (
    <Center mih="100vh" bg="var(--mantine-color-body)">
      <Suspense
        fallback={
          <Stack align="center" gap="md">
            <Loader size="lg" />
            <Text c="dimmed">Loading...</Text>
          </Stack>
        }
      >
        <ResetPasswordForm />
      </Suspense>
    </Center>
  );
}
