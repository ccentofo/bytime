import { Center, Stack, Title, Text, ThemeIcon, Anchor, Button } from '@mantine/core';
import { IconHandStop, IconDownload } from '@tabler/icons-react';
import { SignOutButton } from '@/components/auth/SignOutButton';

/**
 * F5: shown to EVERY signed-in user (admins included) of a workspace suspended for a policy breach (Terms §17.3).
 * No billing (paying doesn't lift it) and no export unless the founder allowed it for this workspace — then an
 * admin also gets the export link. The export endpoint enforces the same rule; this is only the screen.
 */
export function PolicyHoldScreen({ canExport }: { canExport: boolean }) {
  return (
    <Center component="main" mih="100vh" p="xl">
      <Stack maw={480} gap="md" align="center" ta="center">
        <ThemeIcon size={64} radius="xl" color="warning" variant="light">
          <IconHandStop size={32} />
        </ThemeIcon>
        <Stack gap="xs" align="center">
          <Title order={1} size="h2">Workspace on hold</Title>
          <Text c="dimmed">
            Access to this workspace is on hold. Please contact{' '}
            <Anchor href="mailto:support@cadenzpoint.com">support@cadenzpoint.com</Anchor>.
          </Text>
        </Stack>
        {canExport && (
          <Button component="a" href="/api/export/workspace" variant="light" leftSection={<IconDownload size={16} />}>
            Export all workspace data
          </Button>
        )}
        <SignOutButton />
      </Stack>
    </Center>
  );
}
