import { Center, Stack, Title, Text, Anchor } from '@mantine/core';
import type { TenantState } from '@/lib/tenant/context';

type Reason = Exclude<TenantState['kind'], 'active'>;

const COPY: Record<Reason, { title: string; body: string }> = {
  none: {
    title: 'No workspace selected',
    body: 'Open your organization’s workspace URL (for example, your-company.example.com) to sign in.',
  },
  unknown: {
    title: 'Workspace not found',
    body: 'This workspace doesn’t exist. Double-check the address, or contact your administrator.',
  },
  suspended: {
    title: 'Workspace suspended',
    body: 'Access is paused due to a billing issue. An administrator can restore access from billing settings.',
    // TODO (billing blueprint): link directly to the Stripe customer portal, and exempt
    // /admin/billing from the suspension gate so admins can self-serve a fix.
  },
  deleting: {
    title: 'Workspace closed',
    body: 'This workspace is being removed and is no longer available.',
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

/** Clean, themed screen shown by the (app) layout when the tenant is not active. */
export function TenantUnavailable({ reason }: { reason: Reason }) {
  const copy = COPY[reason] ?? COPY.unknown;
  return (
    <Center mih="100vh" p="xl">
      <Stack maw={460} gap="sm" align="center" ta="center">
        <Title order={2}>{copy.title}</Title>
        <Text c="dimmed">{copy.body}</Text>
        <Text size="sm" c="dimmed">
          Need help? Contact <Anchor href="mailto:support@example.com">support</Anchor>.
        </Text>
      </Stack>
    </Center>
  );
}
