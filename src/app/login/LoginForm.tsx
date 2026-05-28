'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Center,
  Stack,
  Paper,
  Title,
  TextInput,
  PasswordInput,
  Button,
  Alert,
  Avatar,
  Text,
  Anchor,
} from '@mantine/core';
import { IconAlertCircle, IconLock } from '@tabler/icons-react';
import { signIn } from 'next-auth/react';
import { checkLockout } from '@/server/actions/login-attempts';

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [lockoutMessage, setLockoutMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [failedCount, setFailedCount] = useState(0);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLockoutMessage('');

    if (!email.trim() || !password) {
      setError('Please enter both email and password.');
      return;
    }

    // Show loading IMMEDIATELY — before any async calls
    setLoading(true);

    // Client-side lockout check (server also enforces this)
    const lockoutInfo = await checkLockout(email.toLowerCase().trim());
    if (lockoutInfo?.isLocked) {
      setLoading(false);
      setLockoutMessage(
        `Account is temporarily locked due to too many failed login attempts. Please try again in ${lockoutInfo.minutesRemaining} minute${lockoutInfo.minutesRemaining !== 1 ? 's' : ''}.`
      );
      return;
    }

    const result = await signIn('credentials', {
      email: email.toLowerCase().trim(),
      password,
      redirect: false,
    });

    setLoading(false);

    if (result?.error) {
      // Check updated lockout status after this failure
      const updatedLockout = await checkLockout(email.toLowerCase().trim());
      const attempts = updatedLockout?.failedAttempts ?? 0;
      setFailedCount(attempts);

      if (updatedLockout?.isLocked) {
        setLockoutMessage(
          `Account is temporarily locked due to too many failed login attempts. Please try again in ${updatedLockout.minutesRemaining} minute${updatedLockout.minutesRemaining !== 1 ? 's' : ''}.`
        );
        setError('');
      } else {
        const remaining = 5 - attempts;
        if (remaining <= 2 && remaining > 0) {
          setError(`Invalid email or password. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining before account lockout.`);
        } else {
          setError('Invalid email or password.');
        }
      }
      return;
    }

    router.push('/timesheet');
    router.refresh();
  }

  return (
    <Center mih="100vh" bg="var(--mantine-color-body)">
      <Paper shadow="md" p="xl" radius="md" w={420} withBorder>
        <Stack align="center" mb="lg">
          <Avatar src="/logo.png" size="lg" radius="sm" />
          <Title order={2}>ByTime</Title>
          <Text c="dimmed" size="sm">
            DCAA-Compliant Timekeeping
          </Text>
        </Stack>

        {lockoutMessage && (
          <Alert
            icon={<IconLock size={16} />}
            color="orange"
            mb="md"
            variant="light"
            title="Account Locked"
          >
            {lockoutMessage}
          </Alert>
        )}

        {error && !lockoutMessage && (
          <Alert
            icon={<IconAlertCircle size={16} />}
            color="red"
            mb="md"
            variant="light"
          >
            {error}
          </Alert>
        )}

        <form onSubmit={handleSubmit}>
          <Stack>
            <TextInput
              label="Email"
              placeholder="you@company.com"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              disabled={Boolean(lockoutMessage)}
            />
            <PasswordInput
              label="Password"
              placeholder="Enter your password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              disabled={Boolean(lockoutMessage)}
            />
            <Anchor href="/forgot-password" size="sm" ta="right">
              Forgot password?
            </Anchor>
            <Button
              type="submit"
              fullWidth
              loading={loading}
              disabled={Boolean(lockoutMessage)}
            >
              Sign In
            </Button>
          </Stack>
        </form>
      </Paper>
    </Center>
  );
}
