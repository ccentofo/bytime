'use client';

import { useTransition } from 'react';
import { Center, Stack, Title, Text, Button, Alert, ThemeIcon } from '@mantine/core';
import { IconCreditCard, IconAlertCircle } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { openBillingPortal } from '@/server/actions/billing';

interface Props {
  role: string;
}

/**
 * Billing wall shown to users on a suspended tenant.
 * Admins can open the Stripe portal to pay and reactivate.
 * Non-admins see a message to contact their administrator.
 * No app data is accessible — getDb() stays strict and rejects suspended.
 */
export function BillingWall({ role }: Props) {
  const isAdmin = role === 'admin';
  const [isPending, startTransition] = useTransition();

  function handlePortal() {
    startTransition(async () => {
      try {
        const { url } = await openBillingPortal();
        window.location.href = url;
      } catch (err) {
        notifications.show({
          title: 'Could not open billing portal',
          message: String(err),
          color: 'red',
        });
      }
    });
  }

  return (
    <Center mih="100vh" p="xl">
      <Stack maw={480} gap="lg" align="center" ta="center">
        <ThemeIcon size={64} radius="xl" color="orange" variant="light">
          <IconCreditCard size={32} />
        </ThemeIcon>

        <Stack gap="xs" align="center">
          <Title order={2}>Subscription inactive</Title>
          <Text c="dimmed">
            Access to this workspace has been paused due to a billing issue.
            {isAdmin
              ? ' Update your billing information to restore access.'
              : ' Please contact your administrator to restore access.'}
          </Text>
        </Stack>

        {isAdmin ? (
          <Button
            size="md"
            leftSection={<IconCreditCard size={16} />}
            loading={isPending}
            onClick={handlePortal}
          >
            Manage billing
          </Button>
        ) : (
          <Alert icon={<IconAlertCircle size={16} />} color="orange" variant="light" maw={400}>
            <Text size="sm">
              Ask your workspace administrator to update billing and restore access.
            </Text>
          </Alert>
        )}

        <Text size="xs" c="dimmed">
          Access is restored automatically once payment is confirmed — usually within a minute.
        </Text>
      </Stack>
    </Center>
  );
}
