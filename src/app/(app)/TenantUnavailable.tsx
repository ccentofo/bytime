import { Center, Stack, Title, Text, Anchor } from '@mantine/core';
import type { TenantState } from '@/lib/tenant/context';
import { rootDomain } from '@/lib/tenant/host';

type Reason = Exclude<TenantState['kind'], 'full' | 'read_only' | 'billing_only' | 'policy_hold'>;

// Server-rendered: rootDomain() reads the server-only APP_ROOT_DOMAIN.
const COPY: Record<Reason, { title: string; body: string }> = {
  none: {
    title: 'No workspace selected',
    body: `Open your organization’s workspace URL (for example, your-company.${rootDomain()}) to sign in.`,
  },
  unknown: {
    title: 'Workspace not found',
    body: 'This workspace doesn’t exist. Double-check the address, or contact your administrator.',
  },
  // feature-plan-terms-compliance.md §3.1: covers deleting/deleted status AND a workspace past
  // its deletion window but not yet actually deleted (D4: deletion is founder-run, so there's a
  // real gap between "scheduled" and "gone") — all of it reads as "closed" to the user.
  closed: {
    title: 'Workspace closed',
    body: 'This workspace is no longer available.',
  },
  provisioning: {
    title: 'Setting up your workspace',
    body: 'Your workspace is still being prepared. This usually takes a moment — please try again shortly.',
  },
  mismatch: {
    title: 'Request could not be verified',
    body: 'The workspace context didn’t validate. Reload the page directly from your workspace URL.',
  },
};

/** Clean, themed screen shown by the (app) layout when the tenant isn't in a usable access mode. */
export function TenantUnavailable({ reason }: { reason: Reason }) {
  const copy = COPY[reason] ?? COPY.unknown;
  return (
    <Center mih="100vh" p="xl">
      <Stack maw={460} gap="sm" align="center" ta="center">
        <Title order={2}>{copy.title}</Title>
        <Text c="dimmed">{copy.body}</Text>
        <Text size="sm" c="dimmed">
          Need help? Contact <Anchor href="mailto:support@cadenzpoint.com">support</Anchor>.
        </Text>
      </Stack>
    </Center>
  );
}
