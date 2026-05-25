import {
  Html,
  Head,
  Body,
  Container,
  Text,
  Heading,
  Section,
  Hr,
  Link,
} from '@react-email/components';
import * as React from 'react';

type Props = {
  employeeName: string;
  periodLabel: string;
  approvedBy: string;
  approvedAt: string;
  appUrl: string;
};

export function TimesheetApprovedEmail({
  employeeName,
  periodLabel,
  approvedBy,
  approvedAt,
  appUrl,
}: Props) {
  return (
    <Html>
      <Head />
      <Body style={bodyStyle}>
        <Container style={containerStyle}>
          <Heading style={headingStyle}>✅ Timesheet Approved</Heading>
          <Text style={textStyle}>Hello {employeeName},</Text>
          <Text style={textStyle}>
            Your timesheet for <strong>{periodLabel}</strong> has been approved
            by <strong>{approvedBy}</strong> on {approvedAt}.
          </Text>
          <Text style={textStyle}>No further action is required.</Text>
          <Section style={ctaStyle}>
            <Link href={`${appUrl}/timesheet`} style={buttonStyle}>
              View Timesheet
            </Link>
          </Section>
          <Hr style={hrStyle} />
          <Text style={footerStyle}>
            ByTime — DCAA-Compliant Timekeeping
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

const bodyStyle = { backgroundColor: '#f6f6f6', fontFamily: 'Arial, sans-serif' };
const containerStyle = { maxWidth: '560px', margin: '0 auto', padding: '20px', backgroundColor: '#ffffff', borderRadius: '8px' };
const headingStyle = { fontSize: '20px', color: '#333', marginBottom: '16px' };
const textStyle = { fontSize: '14px', color: '#555', lineHeight: '1.6' };
const ctaStyle = { textAlign: 'center' as const, marginTop: '24px', marginBottom: '24px' };
const buttonStyle = { backgroundColor: '#40c057', color: '#ffffff', padding: '12px 24px', borderRadius: '6px', textDecoration: 'none', fontSize: '14px', fontWeight: 'bold' as const };
const hrStyle = { borderColor: '#e0e0e0', marginTop: '24px' };
const footerStyle = { fontSize: '11px', color: '#999', textAlign: 'center' as const };
