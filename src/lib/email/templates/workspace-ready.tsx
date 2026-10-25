import { Html, Head, Body, Container, Text, Button, Hr, Section } from '@react-email/components';

interface WorkspaceReadyEmailProps {
  companyName: string;
  workspaceHost: string;
  setPasswordUrl: string;
  appUrl: string;
}

/** Sent when the founder provisions a waitlisted signup (feature-plan-launch-blockers.md P5): set your password. */
export function WorkspaceReadyEmail({ companyName, workspaceHost, setPasswordUrl, appUrl }: WorkspaceReadyEmailProps) {
  return (
    <Html>
      <Head />
      <Body style={{ fontFamily: 'system-ui, sans-serif', backgroundColor: '#f9fafb', padding: '20px' }}>
        <Container style={{ maxWidth: '480px', margin: '0 auto', backgroundColor: '#ffffff', borderRadius: '8px', padding: '32px', border: '1px solid #e5e7eb' }}>
          <Text style={{ fontSize: '20px', fontWeight: 'bold', marginBottom: '16px' }}>
            Your CadenzPoint workspace is ready
          </Text>
          <Text style={{ fontSize: '14px', color: '#374151', lineHeight: '1.6' }}>
            Thanks for waiting! The <strong>{companyName}</strong> workspace is ready at <strong>{workspaceHost}</strong>.
            Set your password to sign in.
          </Text>
          <Section style={{ textAlign: 'center', margin: '24px 0' }}>
            <Button
              href={setPasswordUrl}
              style={{ backgroundColor: '#228be6', color: '#ffffff', padding: '12px 24px', borderRadius: '6px', textDecoration: 'none', fontWeight: '600', fontSize: '14px', display: 'inline-block' }}
            >
              Set your password
            </Button>
          </Section>
          <Text style={{ fontSize: '13px', color: '#6b7280', lineHeight: '1.6' }}>
            This link expires in 72 hours. If it expires, use “Forgot password” on your workspace’s sign-in page.
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
