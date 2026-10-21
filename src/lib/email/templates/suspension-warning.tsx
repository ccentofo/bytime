import { Html, Head, Body, Container, Text, Button, Hr, Section } from '@react-email/components';

interface SuspensionWarningEmailProps {
  tenantName: string;
  daysUntilSuspension: number;
  appUrl: string;
}

export function SuspensionWarningEmail({ tenantName, daysUntilSuspension, appUrl }: SuspensionWarningEmailProps) {
  return (
    <Html>
      <Head />
      <Body style={{ fontFamily: 'system-ui, sans-serif', backgroundColor: '#f9fafb', padding: '20px' }}>
        <Container style={{ maxWidth: '480px', margin: '0 auto', backgroundColor: '#ffffff', borderRadius: '8px', padding: '32px', border: '1px solid #e5e7eb' }}>
          <Text style={{ fontSize: '20px', fontWeight: 'bold', marginBottom: '16px', color: '#c2410c' }}>
            {tenantName} will be suspended in {daysUntilSuspension} day{daysUntilSuspension === 1 ? '' : 's'}
          </Text>
          <Text style={{ fontSize: '14px', color: '#374151', lineHeight: '1.6' }}>
            We still haven't been able to process payment for <strong>{tenantName}</strong>. Unless it's
            resolved, your workspace will be suspended in {daysUntilSuspension} day{daysUntilSuspension === 1 ? '' : 's'} —
            only admins will be able to sign in, and only to manage billing.
          </Text>
          <Section style={{ textAlign: 'center', margin: '24px 0' }}>
            <Button
              href={`${appUrl}/admin/billing`}
              style={{ backgroundColor: '#228be6', color: '#ffffff', padding: '12px 24px', borderRadius: '6px', textDecoration: 'none', fontSize: '14px', fontWeight: 'bold' }}
            >
              Update payment method
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
