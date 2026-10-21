'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Center,
  Stack,
  Paper,
  TextInput,
  PasswordInput,
  PinInput,
  Button,
  Alert,
  Text,
  Anchor,
} from '@mantine/core';
import { IconAlertCircle, IconLock, IconShieldCheck } from '@tabler/icons-react';
import { signIn } from 'next-auth/react';
import { checkLockout } from '@/server/actions/login-attempts';
import { Logo } from '@/components/brand/Logo';

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [lockoutMessage, setLockoutMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [failedCount, setFailedCount] = useState(0);

  // MFA step — revealed in place once the server signals a code is required. No session exists
  // until this also passes: the first signIn() call never creates one when totpEnabled is true.
  const [mfaRequired, setMfaRequired] = useState(false);
  const [mfaCode, setMfaCode] = useState('');
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLockoutMessage('');

    if (!email.trim() || !password) {
      setError('Please enter both email and password.');
      return;
    }
    if (mfaRequired) {
      const code = useRecoveryCode ? recoveryCode.trim() : mfaCode.trim();
      if (!code) {
        setError('Please enter your authentication code.');
        return;
      }
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
      mfaCode: mfaRequired ? (useRecoveryCode ? recoveryCode.trim() : mfaCode.trim()) : undefined,
      redirect: false,
    });

    setLoading(false);

    if (result?.code === 'mfa_required') {
      setMfaRequired(true);
      return;
    }

    if (result?.code === 'mfa_invalid') {
      setError('Invalid code. Please try again.');
      setMfaCode('');
      return;
    }

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

    // Success — a session now exists (MFA, if enabled, already passed).
    router.push('/timesheet');
    router.refresh();
  }

  return (
    <Center mih="100vh" bg="var(--mantine-color-body)">
      <Paper shadow="md" p="xl" radius="md" w={420} withBorder>
        <Stack align="center" mb="lg">
          <Logo size="lg" />
          <Text c="dimmed" size="sm">
            DCAA-Compliant Timekeeping
          </Text>
        </Stack>

        {lockoutMessage && (
          <Alert
            icon={<IconLock size={16} />}
            color="warning"
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
              disabled={Boolean(lockoutMessage) || mfaRequired}
            />
            <PasswordInput
              label="Password"
              placeholder="Enter your password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              disabled={Boolean(lockoutMessage) || mfaRequired}
            />
            {!mfaRequired && (
              <Anchor href="/forgot-password" size="sm" ta="right">
                Forgot password?
              </Anchor>
            )}

            {mfaRequired && (
              <Stack gap="xs" align={useRecoveryCode ? 'stretch' : 'center'}>
                <Text size="sm" fw={600} ta="center">
                  {useRecoveryCode
                    ? 'Enter one of your recovery codes'
                    : 'Enter the 6-digit code from your authenticator app'}
                </Text>
                {!useRecoveryCode ? (
                  <PinInput
                    length={6}
                    type="number"
                    value={mfaCode}
                    onChange={setMfaCode}
                    autoFocus
                    size="lg"
                    disabled={Boolean(lockoutMessage)}
                  />
                ) : (
                  <TextInput
                    placeholder="Enter 8-character recovery code"
                    value={recoveryCode}
                    onChange={(e) => setRecoveryCode(e.target.value.toUpperCase())}
                    autoFocus
                    maxLength={8}
                    disabled={Boolean(lockoutMessage)}
                  />
                )}
                <Anchor
                  size="sm"
                  onClick={() => { setUseRecoveryCode((v) => !v); setError(''); setMfaCode(''); setRecoveryCode(''); }}
                >
                  {useRecoveryCode ? 'Use authenticator app instead' : 'Use a recovery code instead'}
                </Anchor>
              </Stack>
            )}

            <Button
              type="submit"
              fullWidth
              loading={loading}
              disabled={Boolean(lockoutMessage)}
              leftSection={mfaRequired ? <IconShieldCheck size={16} /> : undefined}
            >
              {mfaRequired ? 'Verify' : 'Sign In'}
            </Button>
          </Stack>
        </form>
      </Paper>
    </Center>
  );
}
