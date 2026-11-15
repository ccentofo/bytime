'use client';

import { useEffect, useState, useTransition, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Container, Title, Text, Paper, Group, Stack, Button, Alert, SimpleGrid, Progress,
} from '@mantine/core';
import { IconCheck, IconAlertCircle, IconExternalLink } from '@tabler/icons-react';
import { startCheckout, openBillingPortal, type TenantBillingInfo } from '@/server/actions/billing';
// Client-safe strings only (no env reads): price ids never reach the browser (feature-plan-per-user-billing.md §5).
import { ENTERPRISE_MAILTO, PRICE_COPY, STANDARD_USERS_LINE } from '@/lib/billing/plan-copy';
import { runAction } from '@/lib/run-action';
import { PageHeader } from '@/components/ui/PageHeader';

interface Props {
  billing: TenantBillingInfo;
  /** `?status=` from the billing page. Absent (the BillingWall, rendered by the layout, which gets no searchParams in
   * Next 16) → read from the URL (audit A12/R3). */
  checkoutStatus?: string;
  /** The page header's heading level: 1 on the billing page, 2 under BillingWall's own h1 (UX-1 §4.7). */
  headerOrder?: 1 | 2;
}

type Interval = 'month' | 'year';

interface Tile {
  big: string;
  small?: string;
}

interface PaymentTile extends Tile {
  action?: { label: string; href: string };
  /** Shown instead of a missing pay link (rows 1–2). */
  fallback?: string;
  /** Rows 1–3: more than one open invoice. */
  manyInvoices?: boolean;
}

const users = (n: number) => (n === 1 ? '1 active user' : `${n} active users`);

/** Plan tile, first match wins (feature-plan-per-user-billing.md §6.10). */
export function planTile(b: TenantBillingInfo): Tile {
  if (b.plan === 'enterprise') return { big: 'Enterprise', small: 'Custom terms' };
  if (b.plan === 'standard') {
    if (b.ended) return { big: 'Standard' };
    if (b.interval === 'month') return { big: 'Standard', small: 'Billed monthly' };
    if (b.interval === 'year') return { big: 'Standard', small: 'Billed annually' };
    return { big: 'Standard' };
  }
  if (!b.trialDateKnown || b.lifecycleExempt) return { big: 'Free trial' };
  if (!b.trialEnded) {
    const n = b.trialDaysLeft ?? 0;
    return { big: 'Free trial', small: `Ends ${b.trialEnd} · ${n === 1 ? '1 day left' : `${n} days left`}` };
  }
  return { big: 'Free trial', small: `Ended ${b.trialEnd}` };
}

/** Users tile, first match wins (§6.10). `progress` is the trial meter's percentage. */
export function usersTile(b: TenantBillingInfo): Tile & { progress?: number } {
  if (b.seats === null) return { big: '—', small: "Couldn't load the user count." };
  const n = b.seats.active;
  if (b.plan === 'enterprise') return { big: users(n), small: 'No user limit.' };
  if (b.plan === 'standard') {
    if (b.ended) return { big: users(n) };
    const q = b.billedQuantity;
    if (q !== null && q > Math.max(n, 5) && b.billedQuantityApplies && b.renewsOn) {
      return {
        big: users(n),
        small: b.cancelAtPeriodEnd
          ? `Billed for ${q} users until ${b.renewsOn}, when your subscription ends.`
          : `Billed for ${q} users until ${b.renewsOn}. Removed users leave your bill at renewal.`,
      };
    }
    return { big: users(n), small: 'You pay for each active user. The minimum covers 5. Up to 100 users.' };
  }
  const limit = b.seats.limit ?? 10;
  return { big: `${n} of ${limit} used`, small: "Active users count. Inactive users don't.", progress: Math.min(100, Math.round((n / limit) * 100)) };
}

/** Payment tile, first match wins (§6.10 table). Statuses are never shown raw. */
export function paymentTile(b: TenantBillingInfo): PaymentTile {
  const status = b.subscriptionStatus;
  const many = b.openInvoiceCount > 1;
  if (b.suspensionReason === 'nonpayment') {
    return { big: 'Suspended', small: 'Pay the open invoice to restore access.', action: b.payUrl ? { label: 'Pay the invoice', href: b.payUrl } : undefined, fallback: 'Use Manage billing to pay.', manyInvoices: many };
  }
  if (b.overdue) {
    return { big: 'Payment overdue', small: 'Pay the open invoice to avoid suspension.', action: b.payUrl ? { label: 'Pay the invoice', href: b.payUrl } : undefined, fallback: 'Use Manage billing to pay.', manyInvoices: many };
  }
  if ((status === 'past_due' || status === 'unpaid') && !b.ended && b.collectionMethod === 'send_invoice') {
    return { big: 'Invoice open', small: 'Pay it by the due date on the invoice.', action: b.payUrl ? { label: 'Pay the invoice', href: b.payUrl } : undefined, manyInvoices: many };
  }
  if (status === 'incomplete') {
    return {
      big: 'Payment pending',
      small: 'Finish paying in Stripe, or wait for your bank payment to clear. If a bank payment failed, pay another way.',
      action: b.payUrl ? { label: 'Finish paying', href: b.payUrl } : undefined,
      manyInvoices: many,
    };
  }
  if (b.ended) {
    return { big: 'Canceled', small: b.canSubscribe ? `Ended on ${b.endedOn}. Choose a plan to start again.` : `Ended on ${b.endedOn}.` };
  }
  if (status === 'active' || status === 'trialing') {
    const action = b.openInvoiceCount > 0 && b.payUrl ? { label: 'Pay the open invoice', href: b.payUrl } : undefined;
    if (b.cancelAtPeriodEnd) return { big: 'Active', small: b.renewsOn ? `Ends ${b.renewsOn}` : undefined, action };
    return { big: 'Active', small: b.renewsOn ? `Renews ${b.renewsOn}` : undefined, action };
  }
  if (status === 'paused') return { big: 'Paused', small: 'Contact support@cadenzpoint.com.' };
  if (b.lifecycleExempt) return { big: 'None yet' };
  if (!b.trialDateKnown || !b.trialEnded) return { big: 'None yet', small: 'Choose a plan before your trial ends to keep editing.' };
  return { big: 'None yet', small: 'Choose a plan to keep editing.' };
}

/** A tile: the small label, the big text, then (the trial meter), the small text, then (the action). */
function TileBox({ label, tile, meter, children }: { label: string; tile: Tile; meter?: ReactNode; children?: ReactNode }) {
  return (
    <Stack gap={4}>
      <Text size="sm" c="dimmed">{label}</Text>
      <Text fw={700} size="xl">{tile.big}</Text>
      {meter}
      {tile.small && <Text size="sm" c="dimmed">{tile.small}</Text>}
      {children}
    </Stack>
  );
}

export function BillingClient({ billing, checkoutStatus: checkoutStatusProp, headerOrder = 1 }: Props) {
  const sectionOrder = (headerOrder + 1) as 2 | 3; // section headings sit one level below the header
  const cardOrder = (sectionOrder + 1) as 3 | 4;
  const [isPending, startTransition] = useTransition();
  const [pending, setPending] = useState<Interval | 'portal' | null>(null);
  const router = useRouter();
  const searchParams = useSearchParams();
  const checkoutStatus = checkoutStatusProp ?? searchParams.get('status') ?? undefined;

  // Back from Stripe Checkout: the webhook that activates the plan usually lands within seconds. Refresh once after
  // 5 s so the page picks it up (one refresh — not a polling loop).
  useEffect(() => {
    if (checkoutStatus !== 'success') return;
    const timer = setTimeout(() => router.refresh(), 5000);
    return () => clearTimeout(timer);
  }, [checkoutStatus, router]);

  function handleSubscribe(interval: Interval) {
    setPending(interval);
    startTransition(async () => {
      const result = await runAction(startCheckout(interval), { errorTitle: 'Checkout failed' });
      if (result.ok) window.location.href = result.data.url;
      else setPending(null);
    });
  }

  function handlePortal() {
    setPending('portal');
    startTransition(async () => {
      const result = await runAction(openBillingPortal(), { errorTitle: 'Portal unavailable' });
      if (result.ok) window.location.href = result.data.url;
      else setPending(null);
    });
  }

  const plan = planTile(billing);
  const seats = usersTile(billing);
  const payment = paymentTile(billing);

  const standardCard = (interval: Interval) => {
    const copy = interval === 'month' ? PRICE_COPY.standardMonthly : PRICE_COPY.standardAnnual;
    const available = billing.standardAvailable[interval];
    return (
      <Paper withBorder p="md" radius="md">
        <Stack gap="xs" h="100%">
          <Title order={cardOrder} size="h5">{interval === 'month' ? 'Standard, monthly' : 'Standard, annual'}</Title>
          <Text fw={700}>{copy.price}</Text>
          <Text size="sm" c="dimmed">{copy.detail}</Text>
          <Text size="sm" c="dimmed">{STANDARD_USERS_LINE}</Text>
          <Button
            mt="auto"
            variant={interval === 'month' ? 'filled' : 'default'}
            loading={isPending && pending === interval}
            disabled={!available || (isPending && pending !== interval)}
            onClick={() => handleSubscribe(interval)}
          >
            {interval === 'month' ? 'Choose monthly' : 'Choose annual'}
          </Button>
          {!available && <Text size="sm" c="dimmed">Not available yet.</Text>}
        </Stack>
      </Paper>
    );
  };

  return (
    <Container size="md" py="xl">
      <PageHeader order={headerOrder} title="Billing" description="Your plan, users and payment details." />

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

      <Paper withBorder p="lg" radius="md" mb="md">
        <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="xl">
          <TileBox label="Plan" tile={plan} />
          <TileBox label="Users" tile={seats}
            meter={seats.progress !== undefined ? <Progress value={seats.progress} size="sm" aria-hidden="true" /> : undefined} />
          <TileBox label="Payment" tile={payment}>
            {payment.action && (
              <Button component="a" href={payment.action.href} color="warning" size="sm" w="fit-content" mt={4} rightSection={<IconExternalLink size={14} />}>
                {payment.action.label}
              </Button>
            )}
            {!payment.action && payment.fallback && <Text size="sm">{payment.fallback}</Text>}
            {payment.manyInvoices && (
              <Text size="sm" c="dimmed">{`You have ${billing.openInvoiceCount} open invoices. Manage billing lists them all.`}</Text>
            )}
          </TileBox>
        </SimpleGrid>
      </Paper>

      {billing.hasCustomer && (
        <Group gap="sm" mb="xl">
          <Button
            variant="default"
            size="sm"
            rightSection={<IconExternalLink size={14} />}
            loading={isPending && pending === 'portal'}
            onClick={handlePortal}
          >
            Manage billing
          </Button>
          {!billing.canSubscribe && (
            <Text size="sm" c="dimmed">Use Manage billing to update your payment method, see invoices or cancel.</Text>
          )}
        </Group>
      )}

      {billing.canSubscribe && (
        <>
          <Title order={sectionOrder} size="h4" mb="md">Choose a plan</Title>
          <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="md" mb="md">
            {standardCard('month')}
            {standardCard('year')}
            <Paper withBorder p="md" radius="md">
              <Stack gap="xs" h="100%">
                <Title order={cardOrder} size="h5">Enterprise</Title>
                <Text fw={700}>{PRICE_COPY.enterprise.price}</Text>
                <Text size="sm" c="dimmed">{PRICE_COPY.enterprise.detail}</Text>
                <Button mt="auto" component="a" href={ENTERPRISE_MAILTO} variant="default">Contact us</Button>
              </Stack>
            </Paper>
          </SimpleGrid>
          <Text size="sm" c="dimmed">
            {"You'll finish on Stripe's secure checkout page. Pay by card or US bank account, and enter a promotion code there if you have one."}
          </Text>
        </>
      )}
    </Container>
  );
}
