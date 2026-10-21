import { Html, Head, Body, Container, Text, Button, Hr, Section } from '@react-email/components';

interface DeletionScheduledEmailProps {
  tenantName: string;
  deletionDateFormatted: string;
  isFinalReminder: boolean;
  appUrl: string;
}

export function DeletionScheduledEmail({ tenantName, deletionDateFormatted, isFinalReminder, appUrl }: DeletionScheduledEmailProps) {
  return (
    <Html>
      <Head />
      <Body style={{ fontFamily: 'system-ui, sans-serif', backgroundColor: '#f9fafb', padding: '20px' }}>
        <Container style={{ maxWidth: '480px', margin: '0 auto', backgroundColor: '#ffffff', borderRadius: '8px', padding: '32px', border: '1px solid #e5e7eb' }}>
          <Text style={{ fontSize: '20px', fontWeight: 'bold', marginBottom: '16px', color: '#b91c1c' }}>
            {isFinalReminder ? 'Final reminder: ' : ''}{tenantName} will be deleted on {deletionDateFormatted}
          </Text>
          <Text style={{ fontSize: '14px', color: '#374151', lineHeight: '1.6' }}>
            Your CadenzPoint workspace <strong>{tenantName}</strong> is scheduled for permanent deletion on{' '}
            {deletionDateFormatted}. All data will be permanently removed and cannot be recovered after that
            date.
          </Text>
          <Text style={{ fontSize: '14px', color: '#374151', lineHeight: '1.6' }}>
            If you'd like to keep your data, export the full workspace now, or resubscribe to cancel the
            scheduled deletion.
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
