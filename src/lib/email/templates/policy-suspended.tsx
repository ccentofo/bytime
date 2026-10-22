import { Text } from '@react-email/components';
import { LifecycleLayout, paragraph, smallPrint } from './lifecycle-layout';

/** F5 / Terms §17.3 ("notify you promptly"): a workspace was put on hold for a policy breach. */
export function PolicySuspendedEmail({ tenantName, suspendedAtFormatted }: { tenantName: string; suspendedAtFormatted: string }) {
  return (
    <LifecycleLayout title={`${tenantName} is on hold`} titleColor="#b91c1c">
      <Text style={paragraph}>
        As of <strong>{suspendedAtFormatted}</strong>, access to <strong>{tenantName}</strong> is on hold under our
        Terms of Service (§17.3). Your data is retained and nothing is deleted while the workspace is on hold.
      </Text>
      <Text style={paragraph}>
        Please contact <a href="mailto:support@cadenzpoint.com">support@cadenzpoint.com</a> so we can resolve this with
        you.
      </Text>
      <Text style={smallPrint}>Signing in shows a hold screen until the matter is resolved.</Text>
    </LifecycleLayout>
  );
}
