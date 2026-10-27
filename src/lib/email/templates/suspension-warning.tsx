import { Text } from '@react-email/components';
import { LifecycleLayout, paragraph } from './lifecycle-layout';

export function SuspensionWarningEmail({ tenantName, suspensionDateFormatted, appUrl }: {
  tenantName: string; suspensionDateFormatted: string; appUrl: string;
}) {
  return (
    <LifecycleLayout title={`${tenantName} will be suspended on ${suspensionDateFormatted}`} titleColor="#c2410c" cta={{ href: `${appUrl}/settings/billing`, label: 'Pay now' }}>
      <Text style={paragraph}>
        We still haven&apos;t received payment for <strong>{tenantName}</strong>. Unless it&apos;s resolved, the workspace
        will be suspended on or after <strong>{suspensionDateFormatted}</strong>: only admins will be able to sign in, to pay
        and to export their data.
      </Text>
    </LifecycleLayout>
  );
}
