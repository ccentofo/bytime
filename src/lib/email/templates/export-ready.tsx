import { Text } from '@react-email/components';
import { LifecycleLayout, paragraph, smallPrint } from './lifecycle-layout';

/**
 * feature-plan-cloud-export.md §6.5: the workspace export the founder sent (the Export workspace button). One message per
 * recipient (a Resend batch), so no recipient sees another. The link opens a page on cadenzpoint.com that prepares a
 * short download per click; it works until the stated time (7 days), unless revoked.
 */
export function ExportReadyEmail({ tenantName, link, worksUntilFormatted }: { tenantName: string; link: string; worksUntilFormatted: string }) {
  return (
    <LifecycleLayout title="Your CadenzPoint workspace export is ready" cta={{ href: link, label: 'Open the download page' }}>
      <Text style={paragraph}>
        The full data export of <strong>{tenantName}</strong> is ready to download.
      </Text>
      <Text style={paragraph}>
        The link works until <strong>{worksUntilFormatted}</strong>. After that it stops working and the copy is erased.
      </Text>
      <Text style={paragraph}>
        If the button doesn&apos;t work, copy this address into your browser: {link}
      </Text>
      <Text style={smallPrint}>
        If you didn&apos;t ask for this, contact <a href="mailto:support@cadenzpoint.com">support@cadenzpoint.com</a>.
      </Text>
    </LifecycleLayout>
  );
}
