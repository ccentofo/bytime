import { Html, Head, Body, Container, Text, Button, Hr, Section } from '@react-email/components';

interface SubscriptionEndedEmailProps {
  tenantName: string;
  retentionDays: number;
  appUrl: string;
}

export function SubscriptionEndedEmail({ tenantName, retentionDays, appUrl }: SubscriptionEndedEmailProps) {
  return (
    <Html>
      <Head />
      <Body style={{ fontFamily: 'system-ui, sans-serif', backgroundColor: '#f9fafb', padding: '20px' }}>
        <Container style={{ maxWidth: '480px', margin: '0 auto', backgroundColor: '#ffffff', borderRadius: '8px', padding: '32px', border: '1px solid #e5e7eb' }}>
          <Text style={{ fontSize: '20px', fontWeight: 'bold', marginBottom: '16px' }}>
            Your {tenantName} subscription has ended
          </Text>
          <Text style={{ fontSize: '14px', color: '#374151', lineHeight: '1.6' }}>
            Your CadenzPoint subscription for <strong>{tenantName}</strong> has ended, and the workspace is
            now read-only. Everyone can still sign in and view existing timesheets, but new entries,
            approvals, and other changes are paused.
          </Text>
          <Text style={{ fontSize: '14px', color: '#374151', lineHeight: '1.6' }}>
            Your data will be kept for {retentionDays} days. You can resubscribe at any time to restore full
            access, or export the full workspace before then.
          </Text>
          <Section style={{ textAlign: 'center', margin: '24px 0' }}>
            <Button
              href={`${appUrl}/admin/billing`}
              style={{ backgroundColor: '#228be6', color: '#ffffff', padding: '12px 24px', borderRadius: '6px', textDecoration: 'none', fontSize: '14px', fontWeight: 'bold' }}
            >
              Resubscribe
            </Button>
          </Section>
          <Hr style={{ borderColor: '#e5e7eb', margin: '24px 0' }} />
          <Text style={{ fontSize: '11px', color: '#9ca3af' }}>
            CadenzPoint — DCAA-Compliant Timekeeping
          </Text>
        </Container>
      </Body>
    </Html>
  );
}
