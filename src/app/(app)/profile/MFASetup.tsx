'use client';

import { useState, useTransition } from 'react';
import {
  Paper,
  Title,
  Text,
  Group,
  Button,
  Stack,
  Alert,
  Badge,
  PinInput,
  PasswordInput,
  Code,
  SimpleGrid,
  Divider,
} from '@mantine/core';
import { IconShieldCheck, IconShieldOff, IconAlertCircle, IconCheck, IconQrcode } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { initMFASetup, completeMFASetup, disableMFA } from '@/server/actions/mfa';
import { runAction } from '@/lib/run-action';
import Image from 'next/image';

interface Props {
  mfaEnabled: boolean;
  recoveryCodesRemaining: number;
}

export function MFASetup({ mfaEnabled, recoveryCodesRemaining }: Props) {
  const [isPending, startTransition] = useTransition();
  const [step, setStep] = useState<'idle' | 'setup' | 'verify' | 'recovery' | 'disable'>('idle');
  const [pendingSecret, setPendingSecret] = useState('');
  const [qrUri, setQrUri] = useState('');
  const [verifyCode, setVerifyCode] = useState('');
  const [setupPassword, setSetupPassword] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [disablePassword, setDisablePassword] = useState('');
  const [error, setError] = useState('');

  async function handleStartSetup() {
    setError('');
    startTransition(async () => {
      try {
        const result = await initMFASetup();
        setPendingSecret(result.secret);
        setQrUri(result.uri);
        setStep('setup');
      } catch (err) {
        setError(String(err));
      }
    });
  }

  async function handleVerify() {
    setError('');
    startTransition(async () => {
      const result = await runAction(completeMFASetup({ pendingSecret, code: verifyCode, currentPassword: setupPassword }), { silent: true });
      if (result.ok) {
        setRecoveryCodes(result.data.recoveryCodes);
        setSetupPassword('');
        setStep('recovery');
        notifications.show({ title: '2FA Enabled', message: 'Two-factor authentication is now active.', color: 'success' });
      } else {
        setError(result.error);
        setVerifyCode('');
      }
    });
  }

  async function handleDisable() {
    setError('');
    startTransition(async () => {
      const result = await runAction(disableMFA(disablePassword), { silent: true });
      if (result.ok) {
        setStep('idle');
        setDisablePassword('');
        notifications.show({ title: '2FA Disabled', message: 'Two-factor authentication has been disabled.', color: 'warning' });
        window.location.reload();
      } else {
        setError(result.error);
      }
    });
  }

  // Generate QR code image URL using Google Charts API (no external dependency)
  const qrImageUrl = qrUri
    ? `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(qrUri)}`
    : '';

  return (
    <Paper withBorder p="lg" radius="md" mt="xl">
      <Group mb="md">
        <IconShieldCheck size={20} />
        <Title order={4}>Two-Factor Authentication (2FA)</Title>
        {mfaEnabled ? (
          <Badge color="success" variant="light" ml="auto">Enabled</Badge>
        ) : (
          <Badge color="gray" variant="light" ml="auto">Disabled</Badge>
        )}
      </Group>

      {error && (
        <Alert icon={<IconAlertCircle size={16} />} color="red" variant="light" mb="md">
          {error}
        </Alert>
      )}

      {/* Idle state */}
      {step === 'idle' && !mfaEnabled && (
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            Add an extra layer of security to your account. You'll need an authenticator app like Google Authenticator, Authy, or Microsoft Authenticator.
          </Text>
          <Button
            variant="light"
            leftSection={<IconShieldCheck size={16} />}
            onClick={handleStartSetup}
            loading={isPending}
            w="fit-content"
          >
            Enable 2FA
          </Button>
        </Stack>
      )}

      {/* Already enabled */}
      {step === 'idle' && mfaEnabled && (
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            2FA is active. Recovery codes remaining: <strong>{recoveryCodesRemaining}</strong>
          </Text>
          {recoveryCodesRemaining <= 3 && (
            <Alert color="warning" variant="light">
              You have {recoveryCodesRemaining} recovery codes left. Consider disabling and re-enabling 2FA to generate new codes.
            </Alert>
          )}
          <Button
            variant="subtle"
            color="red"
            leftSection={<IconShieldOff size={16} />}
            onClick={() => setStep('disable')}
            w="fit-content"
          >
            Disable 2FA
          </Button>
        </Stack>
      )}

      {/* Setup: show QR code */}
      {step === 'setup' && (
        <Stack gap="md">
          <Text size="sm">
            1. Open your authenticator app and scan this QR code:
          </Text>
          {qrImageUrl && (
            <Group justify="center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={qrImageUrl} alt="QR Code for 2FA setup" width={200} height={200} />
            </Group>
          )}
          <Text size="xs" c="dimmed">
            Can't scan? Enter this code manually: <Code>{pendingSecret}</Code>
          </Text>
          <Divider label="2. Enter the 6-digit code to verify" labelPosition="left" />
          <PinInput
            length={6}
            type="number"
            value={verifyCode}
            onChange={setVerifyCode}
            autoFocus
          />
          {/* Re-authentication (launch-blockers P3). No auto-submit on PIN completion: an empty password would
              count as a failed attempt toward the sign-in lockout. */}
          <PasswordInput
            label="3. Confirm with your current password"
            value={setupPassword}
            onChange={(e) => setSetupPassword(e.currentTarget.value)}
            autoComplete="current-password"
          />
          <Group>
            <Button onClick={handleVerify} loading={isPending} disabled={verifyCode.length !== 6 || !setupPassword}>
              Verify & Enable
            </Button>
            <Button variant="subtle" onClick={() => { setSetupPassword(''); setStep('idle'); }}>Cancel</Button>
          </Group>
        </Stack>
      )}

      {/* Recovery codes */}
      {step === 'recovery' && (
        <Stack gap="md">
          <Alert icon={<IconCheck size={16} />} color="success" variant="light">
            2FA enabled successfully! Save these recovery codes in a safe place. Each code can only be used once.
          </Alert>
          <SimpleGrid cols={2} spacing="xs">
            {recoveryCodes.map((code) => (
              <Code key={code} style={{ textAlign: 'center', padding: '8px', fontSize: '14px' }}>
                {code}
              </Code>
            ))}
          </SimpleGrid>
          <Button onClick={() => { setStep('idle'); window.location.reload(); }}>
            I've saved my recovery codes
          </Button>
        </Stack>
      )}

      {/* Disable 2FA */}
      {step === 'disable' && (
        <Stack gap="md" maw={400}>
          <Text size="sm">Enter your current password to disable 2FA:</Text>
          <PasswordInput
            label="Current Password"
            value={disablePassword}
            onChange={(e) => setDisablePassword(e.target.value)}
            autoFocus
          />
          <Group>
            <Button color="red" onClick={handleDisable} loading={isPending} disabled={!disablePassword}>
              Disable 2FA
            </Button>
            <Button variant="subtle" onClick={() => { setStep('idle'); setDisablePassword(''); setError(''); }}>
              Cancel
            </Button>
          </Group>
        </Stack>
      )}
    </Paper>
  );
}
