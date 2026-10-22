import { Text } from '@react-email/components';
import { LifecycleLayout, paragraph, smallPrint } from './lifecycle-layout';

export function TrialEndedEmail({ tenantName, deletionDateFormatted, appUrl }: {
  tenantName: string; deletionDateFormatted: string; appUrl: string;
}) {
  return (
    <LifecycleLayout title={`Your ${tenantName} trial has ended`} cta={{ href: `${appUrl}/admin/billing`, label: 'Subscribe to restore full access' }}>
      <Text style={paragraph}>
        Your CadenzPoint trial has ended and <strong>{tenantName}</strong> is now read-only. Everyone can still sign in and
        view timesheets; new entries, approvals and other changes are paused until you subscribe.
      </Text>
      <Text style={paragraph}>
        If you don&apos;t subscribe, the workspace and its data may be permanently deleted on or after
        <strong> {deletionDateFormatted}</strong>. We&apos;ll email you again before that.
      </Text>
      <Text style={smallPrint}>An admin can export the full workspace at any time from Settings.</Text>
    </LifecycleLayout>
  );
}
