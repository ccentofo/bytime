'use client';

import { useState, useEffect, useRef } from 'react';
import {
  Center,
  Stack,
  Paper,
  Title,
  Text,
  PinInput,
  Button,
  Alert,
  Anchor,
  TextInput,
} from '@mantine/core';
import { IconShieldCheck, IconAlertCircle } from '@tabler/icons-react';
import { verifyMFALogin } from '@/server/actions/mfa';
import { signIn } from 'next-auth/react';
import { Logo } from '@/components/brand/Logo';

interface Props {
  userId: string;
  email: string;
}

export function MFAVerifyForm({ userId, email }: Props) {
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState('');
  const [secondsLeft, setSecondsLeft] = useState(30);

  // Countdown timer for TOTP window
  useEffect(() => {
    const tick = () => {
      const now = Math.floor(Date.now() / 1000);
      setSecondsLeft(30 - (now % 30));
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, []);

  async function handleVerify() {
    setError('');
    setLoading(true);

    const inputCode = useRecovery ? recoveryCode.trim() : code;
    if (!inputCode || (!useRecovery && inputCode.length !== 6)) {
      setError('Please enter a valid code.');
      setLoading(false);
      return;
    }

    const result = await verifyMFALogin({
      userId,
      code: inputCode,
      isRecoveryCode: useRecovery,
    });

    if (result.success) {
      // Complete the sign-in by redirecting to timesheet
      window.location.href = '/timesheet';
    } else {
      setError(result.error ?? 'Invalid code. Please try again.');
      setCode('');
      setLoading(false);
    }
  }

  return (
    <Center mih="100vh" bg="var(--mantine-color-body)">
      <Paper shadow="md" p="xl" radius="md" w={420} withBorder>
        <Stack align="center" mb="lg">
          <Logo size="lg" />
          <Title order={2}>Two-Factor Authentication</Title>
          <Text c="dimmed" size="sm" ta="center">
            {useRecovery
              ? 'Enter one of your recovery codes'
              : `Enter the 6-digit code from your authenticator app`}
          </Text>
          <Text size="xs" c="dimmed">{email}</Text>
        </Stack>

        {error && (
          <Alert icon={<IconAlertCircle size={16} />} color="red" variant="light" mb="md">
            {error}
          </Alert>
        )}

        {!useRecovery ? (
          <Stack align="center" gap="md">
            <PinInput
              length={6}
              type="number"
              value={code}
              onChange={setCode}
              autoFocus
              size="lg"
              onComplete={handleVerify}
            />
            <Text size="xs" c="dimmed">
              Code refreshes in {secondsLeft}s
            </Text>
            <Button
              fullWidth
              onClick={handleVerify}
              loading={loading}
              disabled={code.length !== 6}
              leftSection={<IconShieldCheck size={16} />}
            >
              Verify
            </Button>
            <Anchor size="sm" onClick={() => { setUseRecovery(true); setError(''); }}>
              Use a recovery code instead
            </Anchor>
          </Stack>
        ) : (
          <Stack gap="md">
            <TextInput
              label="Recovery Code"
              placeholder="Enter 8-character recovery code"
              value={recoveryCode}
              onChange={(e) => setRecoveryCode(e.target.value.toUpperCase())}
              autoFocus
              maxLength={8}
            />
            <Button
              fullWidth
              onClick={handleVerify}
              loading={loading}
              disabled={recoveryCode.length < 6}
              leftSection={<IconShieldCheck size={16} />}
            >
              Verify Recovery Code
            </Button>
            <Anchor size="sm" ta="center" onClick={() => { setUseRecovery(false); setError(''); }}>
              Use authenticator app instead
            </Anchor>
          </Stack>
        )}
      </Paper>
    </Center>
  );
}
