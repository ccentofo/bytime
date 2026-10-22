'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  Container, Title, Text, Paper, Group, Stack, Badge, Button,
  Alert, Divider,
} from '@mantine/core';
import { IconCheck, IconAlertCircle, IconExternalLink } from '@tabler/icons-react';
import { startCheckout, openBillingPortal, type TenantBillingInfo } from '@/server/actions/billing';
// Type-only: plan data (labels, seat limits, purchasable) comes from the server in `billing.plans` — a value import of
// @/lib/billing/plans here would read Stripe price env vars in the browser (empty) (feature-plan-launch-blockers.md P4 §8).
import type { PlanKey } from '@/lib/billing/plans';
import { runAction } from '@/lib/run-action';
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
  const router = useRouter();

  // Back from Stripe Checkout: the webhook that activates the plan usually lands within seconds. Refresh once after
  // 5 s so the page picks it up (one refresh — not a polling loop).
  useEffect(() => {
    if (checkoutStatus !== 'success') return;
    const timer = setTimeout(() => router.refresh(), 5000);
    return () => clearTimeout(timer);
  }, [checkoutStatus, router]);

  async function handleSubscribe(plan: PlanKey) {
    setPendingPlan(plan);
    startTransition(async () => {
      const result = await runAction(startCheckout(plan), { errorTitle: 'Checkout failed' });
      if (result.ok) window.location.href = result.data.url;
      else setPendingPlan(null);
    });
  }

  async function handlePortal() {
    startTransition(async () => {
      const result = await runAction(openBillingPortal(), { errorTitle: 'Portal unavailable' });
      if (result.ok) window.location.href = result.data.url;
    });
  }

  const currentPlan = billing.plans.find((p) => p.key === billing.plan) ?? billing.plans.find((p) => p.key === 'trial')!;
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
          Thanks — your subscription is being activated.
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
          {billing.plans
            .filter((plan) => plan.key !== 'trial')
            .map((plan) => (
              <Paper key={plan.key} withBorder p="md" radius="md">
                <Group justify="space-between">
                  <Stack gap={2}>
                    <Text fw={700}>{plan.label}</Text>
                    <Text size="sm" c="dimmed">
                      {plan.seatLimit == null ? 'Unlimited seats' : `Up to ${plan.seatLimit} users`}
                    </Text>
                  </Stack>
                  <Button
                    size="sm"
                    variant={isCurrent(plan.key) ? 'filled' : 'default'}
                    loading={isPending && pendingPlan === plan.key}
                    disabled={!billing.canSubscribe || !plan.purchasable}
                    onClick={() => handleSubscribe(plan.key)}
                  >
                    {isCurrent(plan.key) ? 'Current plan' : 'Subscribe'}
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
