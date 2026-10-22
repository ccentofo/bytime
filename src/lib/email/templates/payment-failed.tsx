import { Text } from '@react-email/components';
import { LifecycleLayout, paragraph } from './lifecycle-layout';

export function PaymentFailedEmail({ tenantName, suspensionDateFormatted, appUrl }: {
  tenantName: string; suspensionDateFormatted: string; appUrl: string;
}) {
  return (
    <LifecycleLayout title={`Payment failed for ${tenantName}`} titleColor="#c2410c" cta={{ href: `${appUrl}/admin/billing`, label: 'Update payment method' }}>
      <Text style={paragraph}>
        We couldn&apos;t process the latest payment for <strong>{tenantName}</strong>. Your workspace is still fully active.
        If payment isn&apos;t received, it will be suspended on or after <strong>{suspensionDateFormatted}</strong>, after a
        further reminder.
      </Text>
    </LifecycleLayout>
  );
}
