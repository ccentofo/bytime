import { Html, Head, Body, Container, Text, Button, Hr, Section } from '@react-email/components';

interface SuspendedEmailProps {
  tenantName: string;
  appUrl: string;
}

export function SuspendedEmail({ tenantName, appUrl }: SuspendedEmailProps) {
  return (
    <Html>
      <Head />
      <Body style={{ fontFamily: 'system-ui, sans-serif', backgroundColor: '#f9fafb', padding: '20px' }}>
        <Container style={{ maxWidth: '480px', margin: '0 auto', backgroundColor: '#ffffff', borderRadius: '8px', padding: '32px', border: '1px solid #e5e7eb' }}>
          <Text style={{ fontSize: '20px', fontWeight: 'bold', marginBottom: '16px', color: '#c2410c' }}>
            {tenantName} has been suspended
          </Text>
          <Text style={{ fontSize: '14px', color: '#374151', lineHeight: '1.6' }}>
            We were unable to collect payment for <strong>{tenantName}</strong>, so it has been suspended.
            Non-admin users can no longer sign in. Admins can still sign in to update billing and
            export the full workspace.
          </Text>
          <Section style={{ textAlign: 'center', margin: '24px 0' }}>
            <Button
              href={`${appUrl}/admin/billing`}
              style={{ backgroundColor: '#228be6', color: '#ffffff', padding: '12px 24px', borderRadius: '6px', textDecoration: 'none', fontSize: '14px', fontWeight: 'bold' }}
            >
              Update payment method
            </Button>
          </Section>
          <Text style={{ fontSize: '12px', color: '#6b7280', lineHeight: '1.6' }}>
            Access is restored automatically once payment is confirmed.
          </Text>
          <Hr style={{ borderColor: '#e5e7eb', margin: '24px 0' }} />
          <Text style={{ fontSize: '11px', color: '#9ca3af' }}>
            CadenzPoint — DCAA-Compliant Timekeeping
          </Text>
        </Container>
      </Body>
    </Html>
  );
}
