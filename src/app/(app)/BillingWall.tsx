import { Center, Stack, Title, Text, Alert, ThemeIcon, Container, Button } from '@mantine/core';
import { IconCreditCard, IconDownload } from '@tabler/icons-react';
import { getTenantBillingInfo } from '@/server/actions/billing';
import { BillingClient } from './admin/billing/BillingClient';
import { SignOutButton } from '@/components/auth/SignOutButton';

/**
 * Billing wall shown to an ADMIN on a `billing_only` (suspended for NON-PAYMENT) tenant — the
 * layout only renders this for admins; everyone else sees OnHoldScreen instead (§4.7: "admins
 * can sign in, pay"). Reuses the normal billing settings page's Subscribe/Manage billing flow
 * (startCheckout creates a Stripe customer if there isn't one yet) so there's exactly one
 * implementation of "how an admin pays." Business data stays unreachable — getDb() rejects
 * `billing_only` — except the T6 full-workspace export (D8), linked below.
 */
export async function BillingWall() {
  const billing = await getTenantBillingInfo();

  return (
    <Center component="main" mih="100vh" p="xl">
      <Container size="sm" w="100%">
        <Stack gap="lg" align="center" ta="center" mb="xl">
          <ThemeIcon size={64} radius="xl" color="warning" variant="light">
            <IconCreditCard size={32} />
          </ThemeIcon>
          <Stack gap="xs" align="center">
            <Title order={1} size="h2">Workspace suspended</Title>
            <Text c="dimmed">
              Access has been paused due to a billing issue. Pay the outstanding balance or update your billing
              information below to restore access for everyone in your workspace.
            </Text>
          </Stack>
        </Stack>
        <Alert color="warning" variant="light" mb="lg">
          <Text size="sm">
            Access is restored automatically once payment is confirmed — usually within a minute.
          </Text>
        </Alert>
        {/* "Workspace suspended" is this screen's h1; the billing page header sits under it as an h2. */}
        <BillingClient billing={billing} headerOrder={2} />
        <Center mt="lg">
          <Button component="a" href="/api/export/workspace" variant="subtle" leftSection={<IconDownload size={16} />}>
            Export all workspace data
          </Button>
        </Center>
        <Center mt="xs">
          <SignOutButton />
        </Center>
      </Container>
    </Center>
  );
}
