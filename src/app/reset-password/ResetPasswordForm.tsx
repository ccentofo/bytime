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
  Loader,
} from '@mantine/core';
import { IconCheck, IconAlertCircle, IconArrowLeft, IconLock } from '@tabler/icons-react';
import { verifyResetToken, resetPassword } from '@/server/actions/password-reset';
import { runAction } from '@/lib/run-action';
import { Logo } from '@/components/brand/Logo';

/**
 * The two modes' copy (feature-plan-ux-page-fixes.md C9). `welcome=1` (strictly) is the first-run link from signup
 * verification and the waitlist: the new admin sets their first password. Anything else is a password reset.
 */
const COPY = {
  welcome: {
    title: 'Welcome to CadenzPoint',
    intro: (email: string) => <>Your workspace is ready. Set a password for <strong>{email}</strong> to sign in.</>,
    password: 'Password',
    confirm: 'Confirm password',
    submit: 'Set password',
    checking: 'Checking your link…',
    invalid: 'This setup link is invalid or has expired. Use Forgot password to get a new one.',
    invalidLink: 'Forgot password',
    success: 'Your password is set. Sign in to finish setting up your workspace.',
  },
  reset: {
    title: 'Set new password',
    intro: (email: string) => <>Resetting password for <strong>{email}</strong></>,
    password: 'New password',
    confirm: 'Confirm new password',
    submit: 'Reset password',
    checking: 'Verifying reset link...',
    invalid: 'This password reset link is invalid or has expired. Please request a new one.',
    invalidLink: 'Request a new reset link',
    success: 'Your password has been reset successfully! You can now sign in with your new password.',
  },
};

function ResetPasswordFields() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const email = searchParams.get('email') ?? '';
  const copy = COPY[searchParams.get('welcome') === '1' ? 'welcome' : 'reset'];

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
      try {
        const result = await verifyResetToken(email, token);
        setTokenValid(result.valid);
      } catch {
        // Unknown/closed workspace or a server error: show the invalid-link state, never an endless spinner.
        setTokenValid(false);
      } finally {
        setVerifying(false);
      }
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

    const result = await runAction(resetPassword({ email, token, newPassword: password }), { silent: true });
    setLoading(false);
    if (result.ok) {
      setSuccess(true);
    } else {
      setError(result.error);
    }
  }

  if (verifying) {
    return (
      <Stack align="center" gap="md">
        <Loader size="lg" />
        <Text c="dimmed">{copy.checking}</Text>
      </Stack>
    );
  }

  return (
    <Paper shadow="md" p="xl" radius="md" w={420} withBorder>
      <Stack align="center" mb="lg">
        <Logo size="lg" />
        <Title order={1} size="h2">{copy.title}</Title>
      </Stack>

      {!tokenValid && !success ? (
        <Stack align="center" gap="md">
          <Alert icon={<IconAlertCircle size={16} />} color="red" variant="light">
            {copy.invalid}
          </Alert>
          <Anchor href="/forgot-password" size="sm">
            {copy.invalidLink}
          </Anchor>
        </Stack>
      ) : success ? (
        <Stack align="center" gap="md">
          <Alert icon={<IconCheck size={16} />} color="success" variant="light">
            {copy.success}
          </Alert>
          <Button component="a" href="/login" fullWidth>
            Sign in
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
              {copy.intro(email)}
            </Text>
            <PasswordInput
              label={copy.password}
              placeholder="At least 8 characters"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              autoFocus
            />
            <PasswordInput
              label={copy.confirm}
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
              {copy.submit}
            </Button>
            <Anchor href="/login" size="sm" ta="center">
              <IconArrowLeft size={14} style={{ marginRight: 4, verticalAlign: 'middle' }} />
              Back to sign in
            </Anchor>
          </Stack>
        </form>
      )}
    </Paper>
  );
}

/**
 * The reset-password screen (client). Split out of page.tsx so the page can stay a Server Component that exports
 * metadata (feature-plan-ux-foundations.md §4.7); useSearchParams stays inside the Suspense boundary.
 */
export function ResetPasswordForm() {
  return (
    <Center component="main" mih="100vh" bg="var(--mantine-color-body)">
      <Suspense
        fallback={
          <Stack align="center" gap="md">
            <Loader size="lg" />
            <Text c="dimmed">Loading...</Text>
          </Stack>
        }
      >
        <ResetPasswordFields />
      </Suspense>
    </Center>
  );
}
