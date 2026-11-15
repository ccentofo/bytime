import { Text } from '@react-email/components';
import { LifecycleLayout, paragraph } from './lifecycle-layout';

/**
 * feature-plan-per-user-billing.md §6.7 (Q4): the `payment-failed` notice for an invoiced (send_invoice) subscription.
 * Nothing was charged, so it says the invoice is past due. The button opens Billing; Stripe's own invoice email holds
 * the direct payment link for a payer who isn't a workspace user.
 */
export function InvoiceOverdueEmail({ tenantName, suspensionDateFormatted, appUrl }: {
  tenantName: string; suspensionDateFormatted: string; appUrl: string;
}) {
  return (
    <LifecycleLayout title={`Invoice overdue for ${tenantName}`} titleColor="#c2410c" cta={{ href: `${appUrl}/settings/billing`, label: 'Pay the invoice' }}>
      <Text style={paragraph}>
        The invoice for <strong>{tenantName}</strong> is past due. Your workspace is still fully active.
        If payment isn&apos;t received, it will be suspended on or after <strong>{suspensionDateFormatted}</strong>, after a
        further reminder.
      </Text>
    </LifecycleLayout>
  );
}
