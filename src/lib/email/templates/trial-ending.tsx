import { Text } from '@react-email/components';
import { LifecycleLayout, paragraph, smallPrint } from './lifecycle-layout';

export function TrialEndingEmail({ tenantName, trialEndsAtFormatted, appUrl }: {
  tenantName: string; trialEndsAtFormatted: string; appUrl: string;
}) {
  return (
    <LifecycleLayout title={`Your ${tenantName} trial ends on ${trialEndsAtFormatted}`} cta={{ href: `${appUrl}/admin/billing`, label: 'Choose a plan' }}>
      <Text style={paragraph}>
        Your CadenzPoint trial for <strong>{tenantName}</strong> ends on <strong>{trialEndsAtFormatted}</strong>. After that
        the workspace becomes read-only until you subscribe: everyone can still sign in and view timesheets, and an admin can
        export everything, but new time can't be entered.
      </Text>
      <Text style={smallPrint}>The trial ends on schedule even if a reminder can&apos;t be delivered. Subscribing at any time restores full access.</Text>
    </LifecycleLayout>
  );
}
