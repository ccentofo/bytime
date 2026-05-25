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
  todayDate: string;
  appUrl: string;
};

export function DailyReminderEmail({ employeeName, todayDate, appUrl }: Props) {
  return (
    <Html>
      <Head />
      <Body style={bodyStyle}>
        <Container style={containerStyle}>
          <Heading style={headingStyle}>⏰ Daily Time Entry Reminder</Heading>
          <Text style={textStyle}>Hello {employeeName},</Text>
          <Text style={textStyle}>
            This is a friendly reminder to enter your time for <strong>{todayDate}</strong>.
          </Text>
          <Text style={textStyle}>
            Per DCAA requirements, time must be recorded daily. Please log your hours
            before the end of the business day.
          </Text>
          <Section style={ctaStyle}>
            <Link href={`${appUrl}/timesheet`} style={buttonStyle}>
              Enter Time Now
            </Link>
          </Section>
          <Hr style={hrStyle} />
          <Text style={footerStyle}>
            ByTime — DCAA-Compliant Timekeeping<br />
            You can disable these reminders in your notification settings.
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
