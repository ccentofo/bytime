import { Center, Stack, Title, Text, ThemeIcon, Anchor } from '@mantine/core';
import { IconClockPause } from '@tabler/icons-react';
import { SignOutButton } from '@/components/auth/SignOutButton';

/**
 * Shown to a non-admin signed-in user on a `billing_only` (suspended for non-payment) tenant.
 * Only admins see the billing wall (§4.7: "admins can sign in, pay") — everyone else just needs
 * to know the workspace is paused and who to ask, not billing internals. feature-plan-terms-
 * compliance.md T3.
 */
export function OnHoldScreen() {
  return (
    <Center component="main" mih="100vh" p="xl">
      <Stack maw={460} gap="md" align="center" ta="center">
        <ThemeIcon size={64} radius="xl" color="warning" variant="light">
          <IconClockPause size={32} />
        </ThemeIcon>
        <Stack gap="xs" align="center">
          <Title order={1} size="h2">Workspace on hold</Title>
          <Text c="dimmed">
            This workspace is temporarily on hold due to a billing issue. Please contact your
            workspace administrator — they can sign in to resolve it.
          </Text>
        </Stack>
        <Text size="sm" c="dimmed">
          Need help? Contact <Anchor href="mailto:support@cadenzpoint.com">support</Anchor>.
        </Text>
        <SignOutButton />
      </Stack>
    </Center>
  );
}
