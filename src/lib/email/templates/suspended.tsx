import { Text } from '@react-email/components';
import { LifecycleLayout, paragraph } from './lifecycle-layout';

export function SuspendedEmail({ tenantName, terminationDateFormatted, appUrl }: {
  tenantName: string; terminationDateFormatted: string; appUrl: string;
}) {
  return (
    <LifecycleLayout title={`${tenantName} has been suspended`} titleColor="#b91c1c" cta={{ href: `${appUrl}/admin/billing`, label: 'Pay outstanding balance' }}>
      <Text style={paragraph}>
        <strong>{tenantName}</strong> is suspended for non-payment. Admins can still sign in to pay and to export the
        workspace; access is restored as soon as payment is received.
      </Text>
      <Text style={paragraph}>
        If payment isn&apos;t received, the subscription will be terminated on or after
        <strong> {terminationDateFormatted}</strong>. After termination you&apos;ll still have 90 days to export your data.
      </Text>
    </LifecycleLayout>
  );
}
