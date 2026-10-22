import { Text } from '@react-email/components';
import { LifecycleLayout, paragraph, smallPrint } from './lifecycle-layout';

export function DeletionScheduledEmail({ tenantName, deletionDateFormatted, isFinalReminder, appUrl }: {
  tenantName: string; deletionDateFormatted: string; isFinalReminder: boolean; appUrl: string;
}) {
  return (
    <LifecycleLayout
      title={isFinalReminder ? `Final reminder: ${tenantName} will be deleted on ${deletionDateFormatted}` : `${tenantName} is scheduled for deletion on ${deletionDateFormatted}`}
      titleColor="#b91c1c"
      cta={{ href: `${appUrl}/admin/settings`, label: 'Export your data' }}
    >
      <Text style={paragraph}>
        <strong>{tenantName}</strong> and all of its data will be permanently deleted on or after
        <strong> {deletionDateFormatted}</strong>. Export anything you need to keep before then — government contract rules
        may require you to retain timekeeping records.
      </Text>
      <Text style={smallPrint}>Subscribing before that date cancels the deletion and restores full access.</Text>
    </LifecycleLayout>
  );
}
