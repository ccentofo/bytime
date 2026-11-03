'use client';

import { useEffect, useState, useTransition } from 'react';
import QRCode from 'qrcode';
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
  Loader,
  CopyButton,
} from '@mantine/core';
import { IconShieldCheck, IconShieldOff, IconAlertCircle, IconCheck, IconCopy } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { initMFASetup, completeMFASetup, disableMFA } from '@/server/actions/mfa';
import { runAction } from '@/lib/run-action';

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

  // The QR code is drawn HERE, in the browser, from the otpauth URI: it carries the TOTP shared secret, so it must never
  // be sent to a QR service (feature-plan-hotfix-mfa-qr.md). The result is keyed by the URI it was drawn for, so a stale
  // image never shows for a new setup; null dataUrl = drawing failed (the manual key below still works).
  const [drawnQr, setDrawnQr] = useState<{ uri: string; dataUrl: string | null } | null>(null);
  useEffect(() => {
    if (!qrUri) return;
    let cancelled = false;
    QRCode.toDataURL(qrUri, { width: 200, margin: 1, errorCorrectionLevel: 'M' })
      .then((url) => { if (!cancelled) setDrawnQr({ uri: qrUri, dataUrl: url }); })
      .catch(() => { if (!cancelled) setDrawnQr({ uri: qrUri, dataUrl: null }); });
    return () => { cancelled = true; };
  }, [qrUri]);
  const qr = drawnQr && drawnQr.uri === qrUri ? drawnQr : null;
  const qrDataUrl = qr?.dataUrl ?? null;
  const qrFailed = qr !== null && qr.dataUrl === null;
  // The setup key in groups of 4 for reading; the copy button copies the raw key.
  const groupedKey = pendingSecret.match(/.{1,4}/g)?.join(' ') ?? '';

  async function handleStartSetup() {
    setError('');
    startTransition(async () => {
      const result = await runAction(initMFASetup(), { silent: true });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPendingSecret(result.data.secret);
      setQrUri(result.data.uri);
      setStep('setup');
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
          <Group justify="center" mih={200} data-testid="mfa-qr">
            {qrDataUrl ? (
              // A data: URL drawn in the browser (next/image adds nothing for it).
              // eslint-disable-next-line @next/next/no-img-element
              <img src={qrDataUrl} alt="QR code for your authenticator app" width={200} height={200} />
            ) : qrFailed ? (
              <Alert icon={<IconAlertCircle size={16} />} color="warning" variant="light">
                Couldn&apos;t draw the QR code. Enter the key below in your authenticator app instead.
              </Alert>
            ) : (
              <Group gap="xs">
                <Loader size="sm" />
                <Text size="sm">Generating QR code…</Text>
              </Group>
            )}
          </Group>
          <Stack gap={4}>
            <Text size="sm" c="dimmed">Can&apos;t scan? Enter this key in your authenticator app:</Text>
            <Group gap="xs">
              <Code data-testid="mfa-setup-key">{groupedKey}</Code>
              <CopyButton value={pendingSecret}>
                {({ copied, copy }) => (
                  <Button size="xs" variant="light" leftSection={copied ? <IconCheck size={14} /> : <IconCopy size={14} />} onClick={copy}>
                    {copied ? 'Copied' : 'Copy key'}
                  </Button>
                )}
              </CopyButton>
            </Group>
          </Stack>
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
