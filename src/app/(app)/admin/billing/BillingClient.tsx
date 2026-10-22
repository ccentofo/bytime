'use client';

import { useState, useTransition } from 'react';
import {
  Container, Title, Text, Paper, Group, Stack, Badge, Button,
  Alert, Divider,
} from '@mantine/core';
import { IconCheck, IconAlertCircle, IconExternalLink } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { startCheckout, openBillingPortal, type TenantBillingInfo } from '@/server/actions/billing';
import { PLANS, type PlanKey } from '@/lib/billing/plans';
import { PageHeader } from '@/components/ui/PageHeader';

interface Props {
  billing: TenantBillingInfo;
  checkoutStatus?: string;
}

const STATUS_COLORS: Record<string, string> = {
  active: 'success',
  trialing: 'signal',
  past_due: 'warning',
  canceled: 'red',
  unpaid: 'red',
};

export function BillingClient({ billing, checkoutStatus }: Props) {
  const [isPending, startTransition] = useTransition();
  const [pendingPlan, setPendingPlan] = useState<PlanKey | null>(null);

  async function handleSubscribe(plan: PlanKey) {
    setPendingPlan(plan);
    startTransition(async () => {
      try {
        const { url } = await startCheckout(plan);
        window.location.href = url;
      } catch (err) {
        notifications.show({ title: 'Checkout failed', message: String(err), color: 'red' });
        setPendingPlan(null);
      }
    });
  }

  async function handlePortal() {
    startTransition(async () => {
      try {
        const { url } = await openBillingPortal();
        window.location.href = url;
      } catch (err) {
        notifications.show({ title: 'Portal unavailable', message: String(err), color: 'red' });
      }
    });
  }

  const currentPlan = PLANS[billing.plan as PlanKey] ?? PLANS.trial;
  // "Current plan" only while a subscription is actually running; after it ends, the same plan can be bought again.
  const isCurrent = (key: PlanKey) => !billing.canSubscribe && billing.plan === key;
  const statusColor = billing.subscriptionStatus ? (STATUS_COLORS[billing.subscriptionStatus] ?? 'gray') : 'gray';

  return (
    <Container size="md" py="xl">
      <PageHeader
        title="Billing"
        description="Manage your CadenzPoint subscription, plan, and payment details."
      />

      {checkoutStatus === 'success' && (
        <Alert icon={<IconCheck size={16} />} color="success" variant="light" mb="lg">
          Subscription activated — welcome to {currentPlan.label}!
        </Alert>
      )}
      {checkoutStatus === 'cancelled' && (
        <Alert icon={<IconAlertCircle size={16} />} color="warning" variant="light" mb="lg">
          Checkout was cancelled. You can subscribe any time below.
        </Alert>
      )}

      {/* Current plan */}
      <Paper withBorder p="lg" radius="md" mb="xl">
        <Title order={4} mb="md">Current Plan</Title>
        <Group gap="md">
          <Stack gap={4}>
            <Text fw={700} size="lg">{currentPlan.label}</Text>
            <Text size="sm" c="dimmed">
              {currentPlan.seatLimit == null ? 'Unlimited seats' : `Up to ${currentPlan.seatLimit} active users`}
            </Text>
          </Stack>
          {billing.subscriptionStatus && (
            <Badge color={statusColor} variant="light" size="lg">
              {billing.subscriptionStatus.replace('_', ' ')}
            </Badge>
          )}
          {billing.payUrl && (
            <Button component="a" href={billing.payUrl} color="warning" size="sm" rightSection={<IconExternalLink size={14} />}>
              Pay outstanding balance
            </Button>
          )}
          {billing.hasCustomer && (
            <Button
              variant="default"
              size="sm"
              rightSection={<IconExternalLink size={14} />}
              loading={isPending && pendingPlan === null}
              onClick={handlePortal}
            >
              Manage billing
            </Button>
          )}
        </Group>
      </Paper>

      {/* Plan picker */}
      <Paper withBorder p="lg" radius="md">
        <Title order={4} mb="md">Upgrade Plan</Title>
        <Text size="sm" c="dimmed" mb="lg">
          {billing.canSubscribe
            ? 'All plans include full DCAA-compliant timekeeping.'
            : 'You already have a subscription or a payment in progress. Use Manage billing to change plans or pay.'}
        </Text>
        <Stack gap="md">
          {(Object.entries(PLANS) as [PlanKey, typeof PLANS[PlanKey]][])
            .filter(([key]) => key !== 'trial')
            .map(([key, plan]) => (
              <Paper key={key} withBorder p="md" radius="md">
                <Group justify="space-between">
                  <Stack gap={2}>
                    <Text fw={700}>{plan.label}</Text>
                    <Text size="sm" c="dimmed">
                      {plan.seatLimit == null ? 'Unlimited seats' : `Up to ${plan.seatLimit} users`}
                    </Text>
                  </Stack>
                  <Button
                    size="sm"
                    variant={isCurrent(key) ? 'filled' : 'default'}
                    loading={isPending && pendingPlan === key}
                    disabled={!billing.canSubscribe || !plan.priceId}
                    onClick={() => handleSubscribe(key)}
                  >
                    {isCurrent(key) ? 'Current plan' : 'Subscribe'}
                  </Button>
                </Group>
              </Paper>
            ))}
        </Stack>
        <Divider my="md" />
        <Text size="xs" c="dimmed">
          You will be redirected to Stripe's secure hosted checkout. We never store card details.
        </Text>
      </Paper>
    </Container>
  );
}
