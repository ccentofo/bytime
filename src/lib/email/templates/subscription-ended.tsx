import { Text } from '@react-email/components';
import { LifecycleLayout, paragraph, smallPrint } from './lifecycle-layout';

export function SubscriptionEndedEmail({ tenantName, deletionDateFormatted, appUrl }: {
  tenantName: string; deletionDateFormatted: string; appUrl: string;
}) {
  return (
    <LifecycleLayout title={`Your ${tenantName} subscription has ended`} cta={{ href: `${appUrl}/settings/workspace`, label: 'Export your data' }}>
      <Text style={paragraph}>
        The subscription for <strong>{tenantName}</strong> has ended and the workspace is now read-only. An admin can sign in
        and export everything at any time until <strong>{deletionDateFormatted}</strong>, after which the workspace and its
        data may be permanently deleted.
      </Text>
      <Text style={smallPrint}>Subscribing again before then restores full access immediately.</Text>
    </LifecycleLayout>
  );
}
