'use client';

import { useState, useTransition } from 'react';
import {
  Container, Title, Text, Paper, Group, Stack, Badge, Button,
  Alert, ThemeIcon, Divider,
} from '@mantine/core';
import { IconCreditCard, IconCheck, IconAlertCircle, IconExternalLink } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { startCheckout, openBillingPortal } from '@/server/actions/billing';
import { PLANS, type PlanKey } from '@/lib/billing/plans';

interface Props {
  billing: { plan: string; subscriptionStatus: string | null; hasCustomer: boolean };
  checkoutStatus?: string;
}

const STATUS_COLORS: Record<string, string> = {
  active: 'green',
  trialing: 'blue',
  past_due: 'orange',
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
  const statusColor = billing.subscriptionStatus ? (STATUS_COLORS[billing.subscriptionStatus] ?? 'gray') : 'gray';

  return (
    <Container size="md" py="xl">
      <Group gap="sm" mb="xl">
        <ThemeIcon size="lg" color="blue" variant="light" radius="md">
          <IconCreditCard size={20} />
        </ThemeIcon>
        <Title order={2}>Billing</Title>
      </Group>

      {checkoutStatus === 'success' && (
        <Alert icon={<IconCheck size={16} />} color="green" variant="light" mb="lg">
          Subscription activated — welcome to {currentPlan.label}!
        </Alert>
      )}
      {checkoutStatus === 'cancelled' && (
        <Alert icon={<IconAlertCircle size={16} />} color="yellow" variant="light" mb="lg">
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
          All plans include full DCAA-compliant timekeeping. Upgrade at any time.
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
                    variant={billing.plan === key ? 'filled' : 'default'}
                    loading={isPending && pendingPlan === key}
                    disabled={billing.plan === key || !plan.priceId}
                    onClick={() => handleSubscribe(key)}
                  >
                    {billing.plan === key ? 'Current plan' : 'Subscribe'}
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
