import { Html, Head, Body, Container, Text, Button, Hr, Section } from '@react-email/components';

interface SignupVerifyEmailProps {
  companyName: string;
  verifyUrl: string;
  appUrl: string;
}

export function SignupVerifyEmail({ companyName, verifyUrl, appUrl }: SignupVerifyEmailProps) {
  return (
    <Html>
      <Head />
      <Body style={{ fontFamily: 'system-ui, sans-serif', backgroundColor: '#f9fafb', padding: '20px' }}>
        <Container style={{ maxWidth: '480px', margin: '0 auto', backgroundColor: '#ffffff', borderRadius: '8px', padding: '32px', border: '1px solid #e5e7eb' }}>
          <Text style={{ fontSize: '20px', fontWeight: 'bold', marginBottom: '16px' }}>
            Confirm your email to create your CadenzPoint workspace
          </Text>
          <Text style={{ fontSize: '14px', color: '#374151', lineHeight: '1.6' }}>
            Thanks for signing up! To create your <strong>{companyName}</strong> workspace, please confirm your email address by clicking the button below.
          </Text>
          <Section style={{ textAlign: 'center', margin: '24px 0' }}>
            <Button
              href={verifyUrl}
              style={{
                backgroundColor: '#228be6',
                color: '#ffffff',
                padding: '12px 24px',
                borderRadius: '6px',
                textDecoration: 'none',
                fontWeight: '600',
                fontSize: '14px',
                display: 'inline-block',
              }}
            >
              Confirm Email & Create Workspace
            </Button>
          </Section>
          <Text style={{ fontSize: '13px', color: '#6b7280', lineHeight: '1.6' }}>
            This link expires in 24 hours. If you didn't sign up for CadenzPoint, you can safely ignore this email.
          </Text>
          <Hr style={{ border: 'none', borderTop: '1px solid #e5e7eb', margin: '24px 0' }} />
          <Text style={{ fontSize: '12px', color: '#9ca3af' }}>
            <a href={appUrl} style={{ color: '#9ca3af' }}>CadenzPoint</a> — DCAA-Compliant Timekeeping for Government Contractors
          </Text>
        </Container>
      </Body>
    </Html>
  );
}
