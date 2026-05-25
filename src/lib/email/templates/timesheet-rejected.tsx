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
  rejectedBy: string;
  rejectedAt: string;
  rejectionComment: string;
  appUrl: string;
};

export function TimesheetRejectedEmail({
  employeeName,
  periodLabel,
  rejectedBy,
  rejectedAt,
  rejectionComment,
  appUrl,
}: Props) {
  return (
    <Html>
      <Head />
      <Body style={bodyStyle}>
        <Container style={containerStyle}>
          <Heading style={headingStyle}>⚠️ Timesheet Returned for Corrections</Heading>
          <Text style={textStyle}>Hello {employeeName},</Text>
          <Text style={textStyle}>
            Your timesheet for <strong>{periodLabel}</strong> has been returned for corrections
            by <strong>{rejectedBy}</strong> on {rejectedAt}.
          </Text>
          <Text style={textStyle}>
            <strong>Supervisor's Comment:</strong>
          </Text>
          <Text style={{ ...textStyle, backgroundColor: '#fff3cd', padding: '12px', borderRadius: '4px', borderLeft: '4px solid #ffc107' }}>
            "{rejectionComment}"
          </Text>
          <Text style={textStyle}>
            Please review the comment, make the necessary corrections, and re-submit your timesheet.
          </Text>
          <Section style={ctaStyle}>
            <Link href={`${appUrl}/timesheet`} style={buttonStyle}>
              Edit Timesheet
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
const buttonStyle = { backgroundColor: '#fd7e14', color: '#ffffff', padding: '12px 24px', borderRadius: '6px', textDecoration: 'none', fontSize: '14px', fontWeight: 'bold' as const };
const hrStyle = { borderColor: '#e0e0e0', marginTop: '24px' };
const footerStyle = { fontSize: '11px', color: '#999', textAlign: 'center' as const };
