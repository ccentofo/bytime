import { Html, Head, Body, Container, Text, Button, Hr, Section } from '@react-email/components';

interface PasswordResetEmailProps {
  employeeName: string;
  resetUrl: string;
  expiresIn: string;
  appUrl: string;
}

export function PasswordResetEmail({ employeeName, resetUrl, expiresIn, appUrl }: PasswordResetEmailProps) {
  return (
    <Html>
      <Head />
      <Body style={{ fontFamily: 'system-ui, sans-serif', backgroundColor: '#f9fafb', padding: '20px' }}>
        <Container style={{ maxWidth: '480px', margin: '0 auto', backgroundColor: '#ffffff', borderRadius: '8px', padding: '32px', border: '1px solid #e5e7eb' }}>
          <Text style={{ fontSize: '20px', fontWeight: 'bold', marginBottom: '16px' }}>
            Password Reset Request
          </Text>
          <Text style={{ fontSize: '14px', color: '#374151', lineHeight: '1.6' }}>
            Hi {employeeName},
          </Text>
          <Text style={{ fontSize: '14px', color: '#374151', lineHeight: '1.6' }}>
            We received a request to reset your ByTime password. Click the button below to set a new password:
          </Text>
          <Section style={{ textAlign: 'center', margin: '24px 0' }}>
            <Button
              href={resetUrl}
              style={{
                backgroundColor: '#228be6',
                color: '#ffffff',
                padding: '12px 24px',
                borderRadius: '6px',
                textDecoration: 'none',
                fontSize: '14px',
                fontWeight: 'bold',
              }}
            >
              Reset Password
            </Button>
          </Section>
          <Text style={{ fontSize: '12px', color: '#6b7280', lineHeight: '1.6' }}>
            This link will expire in {expiresIn}. If you didn't request a password reset, you can safely ignore this email — your password will not be changed.
          </Text>
          <Hr style={{ borderColor: '#e5e7eb', margin: '24px 0' }} />
          <Text style={{ fontSize: '11px', color: '#9ca3af' }}>
            ByTime — DCAA-Compliant Timekeeping
          </Text>
        </Container>
      </Body>
    </Html>
  );
}
