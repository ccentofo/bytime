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
  supervisorName: string;
  employeeName: string;
  employeeEmail: string;
  periodLabel: string;
  submittedAt: string;
  appUrl: string;
};

export function TimesheetSubmittedEmail({
  supervisorName,
  employeeName,
  employeeEmail,
  periodLabel,
  submittedAt,
  appUrl,
}: Props) {
  return (
    <Html>
      <Head />
      <Body style={bodyStyle}>
        <Container style={containerStyle}>
          <Heading style={headingStyle}>Timesheet Submitted for Review</Heading>
          <Text style={textStyle}>Hello {supervisorName},</Text>
          <Text style={textStyle}>
            <strong>{employeeName}</strong> ({employeeEmail}) has submitted their timesheet
            for the pay period <strong>{periodLabel}</strong>.
          </Text>
          <Text style={textStyle}>Submitted at: {submittedAt}</Text>
          <Section style={ctaStyle}>
            <Link href={`${appUrl}/admin/approvals`} style={buttonStyle}>
              Review Timesheet
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
const buttonStyle = { backgroundColor: '#228be6', color: '#ffffff', padding: '12px 24px', borderRadius: '6px', textDecoration: 'none', fontSize: '14px', fontWeight: 'bold' as const };
const hrStyle = { borderColor: '#e0e0e0', marginTop: '24px' };
const footerStyle = { fontSize: '11px', color: '#999', textAlign: 'center' as const };
