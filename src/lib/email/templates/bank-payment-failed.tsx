import { Text } from '@react-email/components';
import { LifecycleLayout, paragraph } from './lifecycle-layout';

/**
 * feature-plan-per-user-billing.md §6.9 (Q6, Q11; Terms §4.7): a payment failed while no grace notice covers it (a
 * bank payment Stripe voided with the subscription still active, a failed ACH checkout, or a failed attempt on an
 * invoice that isn't due yet).
 */
export function BankPaymentFailedEmail({ tenantName, appUrl }: { tenantName: string; appUrl: string }) {
  return (
    <LifecycleLayout title={`Payment not received for ${tenantName}`} titleColor="#c2410c" cta={{ href: `${appUrl}/settings/billing`, label: 'Go to Billing' }}>
      <Text style={paragraph}>
        The latest payment for <strong>{tenantName}</strong> didn&apos;t go through. Please update your payment method in
        Billing, or contact support@cadenzpoint.com.
      </Text>
    </LifecycleLayout>
  );
}
