# Blueprint: Email Notifications — Workflow Compliance & Timely Submission Reminders

## 1. Architectural Overview & DCAA Impact

### The Problem

The application currently has no email capability. All workflow notifications (save, submit, approve, reject) are in-app toast notifications only. This means:

1. **Supervisors don't know when timesheets are submitted** — They must manually check the Approvals page
2. **Employees don't know when timesheets are approved/rejected** — They must manually check their timesheet status
3. **No overdue reminders** — Employees who forget to enter time daily receive no prompt
4. **No submission deadline reminders** — Employees may miss the period end date for submitting

### Why This Matters for DCAA

DCAA's daily time entry requirement (FAR 31.201-1) means employees must log time the same day work is performed. Without automated reminders, compliance depends entirely on employee discipline. Email notifications provide a systematic enforcement mechanism that auditors expect.

### Email Provider Strategy

For MVP, we use **Resend** (https://resend.com) — a developer-friendly transactional email API:
- Free tier: 100 emails/day (sufficient for MVP)
- Simple REST API with official Node.js SDK
- React Email support for templated emails
- No SMTP configuration needed
- Excellent deliverability

Alternative providers (Postmark, SendGrid, AWS SES) can be swapped in later by changing the transport layer — the notification logic and templates remain the same.

### Notification Types

| # | Trigger | Recipient | Email Subject Pattern |
|---|---|---|---|
| 1 | **Timesheet Submitted** | Supervisor(s) | "Timesheet Submitted — {Employee} — {Period}" |
| 2 | **Timesheet Approved** | Employee | "Timesheet Approved — {Period}" |
| 3 | **Timesheet Rejected** | Employee | "Timesheet Returned for Corrections — {Period}" |
| 4 | **Daily Entry Reminder** | All employees (cron) | "Reminder: Enter Your Time for {Date}" |
| 5 | **Period Submission Deadline** | Employees with draft timesheets (cron) | "Submit Your Timesheet — Due {Date}" |

### DCAA Compliance Requirements Addressed

| DCAA / FAR Requirement | How Email Notifications Satisfy It |
|---|---|
| **FAR 31.201-1 — Daily Time Entry** | Daily reminder emails prompt employees to log time before the day ends |
| **CAS 418 — Total Time Accounting** | Submission deadline reminders ensure complete period accounting |
| **Approval Workflow** | Email notifications keep supervisors and employees informed of status changes, reducing approval cycle time |
| **Audit Trail** | Email send events can be logged, proving the system actively enforced compliance |

---

## 2. File Topology

```
Files to CREATE:
├── src/lib/email/
│   ├── client.ts                                    ← Resend client singleton
│   ├── templates/
│   │   ├── timesheet-submitted.tsx                  ← React Email template: submission notification
│   │   ├── timesheet-approved.tsx                   ← React Email template: approval notification
│   │   ├── timesheet-rejected.tsx                   ← React Email template: rejection notification
│   │   ├── daily-reminder.tsx                       ← React Email template: daily entry reminder
│   │   └── submission-deadline.tsx                  ← React Email template: period deadline reminder
│   └── send.ts                                      ← Email send functions (one per notification type)
│
├── src/server/actions/notifications.ts              ← Server Actions: trigger notifications
├── src/app/api/cron/
│   ├── daily-reminder/route.ts                      ← Cron endpoint: daily entry reminder
│   └── submission-deadline/route.ts                 ← Cron endpoint: period submission deadline
│
├── src/app/(app)/admin/notifications/
│   ├── page.tsx                                     ← Server Component: notification settings
│   └── NotificationsClient.tsx                      ← Client Component: enable/disable notifications

Files to MODIFY:
├── src/server/actions/periods.ts                    ← Trigger email on submit/approve/reject
├── src/components/shell/AppNavbar.tsx                ← Add "Notifications" nav link
├── src/db/schema.ts                                 ← Add notification preferences table
├── package.json                                     ← Add resend, @react-email/components

Files NOT TOUCHED (guardrail — DO NOT MODIFY):
├── src/auth.ts                                      ← ❌ DO NOT MODIFY
├── src/middleware.ts                                ← ❌ DO NOT MODIFY
├── src/components/timesheet/*                       ← ❌ DO NOT MODIFY
├── src/server/actions/timesheet.ts                  ← ❌ DO NOT MODIFY
├── src/server/actions/contracts.ts                  ← ❌ DO NOT MODIFY
├── src/server/actions/clins.ts                      ← ❌ DO NOT MODIFY
├── src/server/actions/assignments.ts                ← ❌ DO NOT MODIFY
├── src/server/actions/users.ts                      ← ❌ DO NOT MODIFY
├── src/server/actions/dashboard.ts                  ← ❌ DO NOT MODIFY
├── src/server/actions/audit.ts                      ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/contracts/*                   ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/assignments/*                 ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/users/*                       ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/audit-trail/*                 ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/dashboard/*                   ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/labor-categories/*             ← ❌ DO NOT MODIFY
├── src/app/(app)/timesheet/*                         ← ❌ DO NOT MODIFY
```

---

## 3. Step-by-Step Execution Plan

> **⚠️ CRITICAL GUARDRAILS FOR THE EXECUTION AGENT:**
> - **DO NOT** search, grep, or read files inside `node_modules/`, `.next/`, or `dist/`.
> - **DO NOT** modify any files listed in the "DO NOT MODIFY" section above.
> - Use **Mantine v9** imports only (`@mantine/core`, `@mantine/hooks`, `@mantine/notifications`).
> - Use **Resend** SDK for email sending.
> - Use **React Email** components (`@react-email/components`) for email templates.
> - Follow the step order exactly. Each step builds on the previous one.
> - **After completing each phase, run `npm run build` to verify zero errors.**
> - Email sending must be **fire-and-forget** — never block the user action on email delivery.

---

### Phase A: Install Dependencies & Configure (A1–A3)

#### A1. Install email packages

```bash
npm install resend @react-email/components
```

#### A2. Add environment variable to `.env.local`

```env
RESEND_API_KEY=re_your_api_key_here
EMAIL_FROM=noreply@bytime.dev
```

> **Note:** For development, use Resend's test API key which sends to verified domains only. For production, configure a verified sending domain.

#### A3. Create `src/lib/email/client.ts` — Resend client singleton

```typescript
import { Resend } from 'resend';

if (!process.env.RESEND_API_KEY) {
  console.warn('RESEND_API_KEY not set — email notifications will be disabled');
}

export const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

export const EMAIL_FROM = process.env.EMAIL_FROM ?? 'noreply@bytime.dev';

/**
 * Check if email sending is configured and available.
 */
export function isEmailEnabled(): boolean {
  return resend !== null;
}
```

---

### Phase B: Schema Update — Notification Preferences (B1)

#### B1. Modify `src/db/schema.ts` — Add notification preferences table

Add this table at the END of the file, after `timesheetPeriods`:

```typescript
// ---------------------------------------------------------------------------
// Notification Preferences (per-user email notification settings)
// ---------------------------------------------------------------------------

export const notificationPreferences = pgTable('notification_preferences', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }).unique(),
  emailOnSubmit: boolean('email_on_submit').notNull().default(true),       // supervisor: when employee submits
  emailOnApprove: boolean('email_on_approve').notNull().default(true),     // employee: when timesheet approved
  emailOnReject: boolean('email_on_reject').notNull().default(true),       // employee: when timesheet rejected
  emailDailyReminder: boolean('email_daily_reminder').notNull().default(true), // employee: daily entry reminder
  emailDeadlineReminder: boolean('email_deadline_reminder').notNull().default(true), // employee: submission deadline
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

Push the schema:

```bash
npx drizzle-kit push
```

---

### Phase C: Email Templates (C1–C5)

#### C1. Create `src/lib/email/templates/timesheet-submitted.tsx`

```tsx
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
```

#### C2. Create `src/lib/email/templates/timesheet-approved.tsx`

```tsx
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
```

#### C3. Create `src/lib/email/templates/timesheet-rejected.tsx`

```tsx
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
```

#### C4. Create `src/lib/email/templates/daily-reminder.tsx`

```tsx
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
```

#### C5. Create `src/lib/email/templates/submission-deadline.tsx`

```tsx
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
  deadlineDate: string;
  appUrl: string;
};

export function SubmissionDeadlineEmail({
  employeeName,
  periodLabel,
  deadlineDate,
  appUrl,
}: Props) {
  return (
    <Html>
      <Head />
      <Body style={bodyStyle}>
        <Container style={containerStyle}>
          <Heading style={headingStyle}>📋 Timesheet Submission Reminder</Heading>
          <Text style={textStyle}>Hello {employeeName},</Text>
          <Text style={textStyle}>
            The pay period <strong>{periodLabel}</strong> ends on <strong>{deadlineDate}</strong>.
            Please ensure all your hours are entered and submit your timesheet for supervisor review.
          </Text>
          <Text style={textStyle}>
            Your timesheet is currently in <strong>Draft</strong> status and has not been submitted yet.
          </Text>
          <Section style={ctaStyle}>
            <Link href={`${appUrl}/timesheet`} style={buttonStyle}>
              Review & Submit
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
const buttonStyle = { backgroundColor: '#fd7e14', color: '#ffffff', padding: '12px 24px', borderRadius: '6px', textDecoration: 'none', fontSize: '14px', fontWeight: 'bold' as const };
const hrStyle = { borderColor: '#e0e0e0', marginTop: '24px' };
const footerStyle = { fontSize: '11px', color: '#999', textAlign: 'center' as const };
```

---

### Phase D: Email Send Functions (D1)

#### D1. Create `src/lib/email/send.ts`

```typescript
import { resend, EMAIL_FROM, isEmailEnabled } from './client';
import { TimesheetSubmittedEmail } from './templates/timesheet-submitted';
import { TimesheetApprovedEmail } from './templates/timesheet-approved';
import { TimesheetRejectedEmail } from './templates/timesheet-rejected';
import { DailyReminderEmail } from './templates/daily-reminder';
import { SubmissionDeadlineEmail } from './templates/submission-deadline';
import React from 'react';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

// ---------------------------------------------------------------------------
// Email Send Functions (fire-and-forget — never await in user-facing actions)
// ---------------------------------------------------------------------------

/**
 * Send notification to supervisor(s) when an employee submits their timesheet.
 */
export async function sendTimesheetSubmittedEmail(data: {
  supervisorEmail: string;
  supervisorName: string;
  employeeName: string;
  employeeEmail: string;
  periodLabel: string;
  submittedAt: string;
}): Promise<void> {
  if (!isEmailEnabled() || !resend) return;

  try {
    await resend.emails.send({
      from: EMAIL_FROM,
      to: data.supervisorEmail,
      subject: `Timesheet Submitted — ${data.employeeName} — ${data.periodLabel}`,
      react: React.createElement(TimesheetSubmittedEmail, {
        supervisorName: data.supervisorName,
        employeeName: data.employeeName,
        employeeEmail: data.employeeEmail,
        periodLabel: data.periodLabel,
        submittedAt: data.submittedAt,
        appUrl: APP_URL,
      }),
    });
  } catch (error) {
    console.error('Failed to send timesheet submitted email:', error);
  }
}

/**
 * Send notification to employee when their timesheet is approved.
 */
export async function sendTimesheetApprovedEmail(data: {
  employeeEmail: string;
  employeeName: string;
  periodLabel: string;
  approvedBy: string;
  approvedAt: string;
}): Promise<void> {
  if (!isEmailEnabled() || !resend) return;

  try {
    await resend.emails.send({
      from: EMAIL_FROM,
      to: data.employeeEmail,
      subject: `Timesheet Approved — ${data.periodLabel}`,
      react: React.createElement(TimesheetApprovedEmail, {
        employeeName: data.employeeName,
        periodLabel: data.periodLabel,
        approvedBy: data.approvedBy,
        approvedAt: data.approvedAt,
        appUrl: APP_URL,
      }),
    });
  } catch (error) {
    console.error('Failed to send timesheet approved email:', error);
  }
}

/**
 * Send notification to employee when their timesheet is rejected.
 */
export async function sendTimesheetRejectedEmail(data: {
  employeeEmail: string;
  employeeName: string;
  periodLabel: string;
  rejectedBy: string;
  rejectedAt: string;
  rejectionComment: string;
}): Promise<void> {
  if (!isEmailEnabled() || !resend) return;

  try {
    await resend.emails.send({
      from: EMAIL_FROM,
      to: data.employeeEmail,
      subject: `Timesheet Returned for Corrections — ${data.periodLabel}`,
      react: React.createElement(TimesheetRejectedEmail, {
        employeeName: data.employeeName,
        periodLabel: data.periodLabel,
        rejectedBy: data.rejectedBy,
        rejectedAt: data.rejectedAt,
        rejectionComment: data.rejectionComment,
        appUrl: APP_URL,
      }),
    });
  } catch (error) {
    console.error('Failed to send timesheet rejected email:', error);
  }
}

/**
 * Send daily time entry reminder to an employee.
 */
export async function sendDailyReminderEmail(data: {
  employeeEmail: string;
  employeeName: string;
  todayDate: string;
}): Promise<void> {
  if (!isEmailEnabled() || !resend) return;

  try {
    await resend.emails.send({
      from: EMAIL_FROM,
      to: data.employeeEmail,
      subject: `Reminder: Enter Your Time for ${data.todayDate}`,
      react: React.createElement(DailyReminderEmail, {
        employeeName: data.employeeName,
        todayDate: data.todayDate,
        appUrl: APP_URL,
      }),
    });
  } catch (error) {
    console.error('Failed to send daily reminder email:', error);
  }
}

/**
 * Send submission deadline reminder to an employee.
 */
export async function sendSubmissionDeadlineEmail(data: {
  employeeEmail: string;
  employeeName: string;
  periodLabel: string;
  deadlineDate: string;
}): Promise<void> {
  if (!isEmailEnabled() || !resend) return;

  try {
    await resend.emails.send({
      from: EMAIL_FROM,
      to: data.employeeEmail,
      subject: `Submit Your Timesheet — Due ${data.deadlineDate}`,
      react: React.createElement(SubmissionDeadlineEmail, {
        employeeName: data.employeeName,
        periodLabel: data.periodLabel,
        deadlineDate: data.deadlineDate,
        appUrl: APP_URL,
      }),
    });
  } catch (error) {
    console.error('Failed to send submission deadline email:', error);
  }
}
```

---

### Phase E: Notification Server Actions (E1)

#### E1. Create `src/server/actions/notifications.ts`

```typescript
'use server';

import { db } from '@/db';
import { notificationPreferences, users } from '@/db/schema';
import { eq } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Notification Preferences CRUD
// ---------------------------------------------------------------------------

export type NotificationPrefs = {
  emailOnSubmit: boolean;
  emailOnApprove: boolean;
  emailOnReject: boolean;
  emailDailyReminder: boolean;
  emailDeadlineReminder: boolean;
};

const DEFAULT_PREFS: NotificationPrefs = {
  emailOnSubmit: true,
  emailOnApprove: true,
  emailOnReject: true,
  emailDailyReminder: true,
  emailDeadlineReminder: true,
};

/**
 * Get notification preferences for a user.
 * Returns defaults if no record exists.
 */
export async function getNotificationPreferences(userId: string): Promise<NotificationPrefs> {
  const rows = await db
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, userId));

  if (rows.length === 0) return { ...DEFAULT_PREFS };

  const row = rows[0];
  return {
    emailOnSubmit: row.emailOnSubmit,
    emailOnApprove: row.emailOnApprove,
    emailOnReject: row.emailOnReject,
    emailDailyReminder: row.emailDailyReminder,
    emailDeadlineReminder: row.emailDeadlineReminder,
  };
}

/**
 * Update notification preferences for a user.
 * Creates the record if it doesn't exist (upsert).
 */
export async function updateNotificationPreferences(
  userId: string,
  prefs: Partial<NotificationPrefs>
): Promise<void> {
  const existing = await db
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, userId));

  if (existing.length === 0) {
    await db.insert(notificationPreferences).values({
      userId,
      ...DEFAULT_PREFS,
      ...prefs,
    });
  } else {
    await db.update(notificationPreferences)
      .set({ ...prefs, updatedAt: new Date() })
      .where(eq(notificationPreferences.userId, userId));
  }
}

/**
 * Check if a user has a specific notification enabled.
 */
export async function isNotificationEnabled(
  userId: string,
  notificationType: keyof NotificationPrefs
): Promise<boolean> {
  const prefs = await getNotificationPreferences(userId);
  return prefs[notificationType];
}
```

---

### Phase F: Wire Email Triggers into Period Actions (F1)

#### F1. Modify `src/server/actions/periods.ts` — Add email notifications

**F1a.** Add imports at the top of the file:

```typescript
import { sendTimesheetSubmittedEmail, sendTimesheetApprovedEmail, sendTimesheetRejectedEmail } from '@/lib/email/send';
import { isNotificationEnabled } from '@/server/actions/notifications';
import { getNumDaysInPeriod } from '@/lib/date-utils';
```

**F1b.** In `submitPeriod()`, after the successful submission (after the INSERT/UPDATE), add email notification — fire-and-forget (do NOT await):

```typescript
  // Fire-and-forget: notify supervisor(s) via email
  const periodEnd = dayjs(data.periodStart).add(getNumDaysInPeriod(data.periodStart) - 1, 'day');
  const periodLabel = `${dayjs(data.periodStart).format('MMM D')} – ${periodEnd.format('MMM D, YYYY')}`;

  // Get the employee's name
  const [employee] = await db
    .select({ fullName: users.fullName, email: users.email })
    .from(users)
    .where(eq(users.id, data.userId));

  // Get all supervisors/admins and notify them (simplified — no scope filtering for email)
  const supervisors = await db
    .select({ id: users.id, fullName: users.fullName, email: users.email })
    .from(users)
    .where(eq(users.role, 'supervisor'));

  const admins = await db
    .select({ id: users.id, fullName: users.fullName, email: users.email })
    .from(users)
    .where(eq(users.role, 'admin'));

  const reviewers = [...supervisors, ...admins];

  for (const reviewer of reviewers) {
    const enabled = await isNotificationEnabled(reviewer.id, 'emailOnSubmit');
    if (enabled && employee) {
      sendTimesheetSubmittedEmail({
        supervisorEmail: reviewer.email,
        supervisorName: reviewer.fullName,
        employeeName: employee.fullName,
        employeeEmail: employee.email,
        periodLabel,
        submittedAt: dayjs().format('MMM D, YYYY h:mm A'),
      }); // No await — fire-and-forget
    }
  }
```

**F1c.** In `approvePeriod()`, after the successful approval, add email notification:

```typescript
  // Fire-and-forget: notify employee via email
  const period = existing[0];
  const [employee] = await db
    .select({ fullName: users.fullName, email: users.email })
    .from(users)
    .where(eq(users.id, period.userId));

  const [reviewer] = await db
    .select({ fullName: users.fullName })
    .from(users)
    .where(eq(users.id, data.reviewedBy));

  if (employee) {
    const enabled = await isNotificationEnabled(period.userId, 'emailOnApprove');
    if (enabled) {
      const periodEnd = dayjs(period.periodStart).add(getNumDaysInPeriod(period.periodStart) - 1, 'day');
      const periodLabel = `${dayjs(period.periodStart).format('MMM D')} – ${periodEnd.format('MMM D, YYYY')}`;

      sendTimesheetApprovedEmail({
        employeeEmail: employee.email,
        employeeName: employee.fullName,
        periodLabel,
        approvedBy: reviewer?.fullName ?? 'Supervisor',
        approvedAt: dayjs().format('MMM D, YYYY h:mm A'),
      }); // No await — fire-and-forget
    }
  }
```

**F1d.** In `rejectPeriod()`, after the successful rejection, add email notification:

```typescript
  // Fire-and-forget: notify employee via email
  const period = existing[0];
  const [employee] = await db
    .select({ fullName: users.fullName, email: users.email })
    .from(users)
    .where(eq(users.id, period.userId));

  const [reviewer] = await db
    .select({ fullName: users.fullName })
    .from(users)
    .where(eq(users.id, data.reviewedBy));

  if (employee) {
    const enabled = await isNotificationEnabled(period.userId, 'emailOnReject');
    if (enabled) {
      const periodEnd = dayjs(period.periodStart).add(getNumDaysInPeriod(period.periodStart) - 1, 'day');
      const periodLabel = `${dayjs(period.periodStart).format('MMM D')} – ${periodEnd.format('MMM D, YYYY')}`;

      sendTimesheetRejectedEmail({
        employeeEmail: employee.email,
        employeeName: employee.fullName,
        periodLabel,
        rejectedBy: reviewer?.fullName ?? 'Supervisor',
        rejectedAt: dayjs().format('MMM D, YYYY h:mm A'),
        rejectionComment: data.comment,
      }); // No await — fire-and-forget
    }
  }
```

---

### Phase G: Cron Endpoints (G1–G2)

#### G1. Create `src/app/api/cron/daily-reminder/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { users, timesheetEntries, notificationPreferences } from '@/db/schema';
import { eq, and, gte, lt, sql } from 'drizzle-orm';
import dayjs from 'dayjs';
import { sendDailyReminderEmail } from '@/lib/email/send';

/**
 * Cron endpoint: Send daily time entry reminders.
 * Should be called once per day (e.g., 4:00 PM local time) on weekdays.
 *
 * Sends reminders to employees who have NOT entered time for today.
 *
 * Protect this endpoint with a CRON_SECRET header in production.
 */
export async function GET(request: NextRequest) {
  // Optional: verify cron secret
  const cronSecret = request.headers.get('x-cron-secret');
  if (process.env.CRON_SECRET && cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const today = dayjs().startOf('day');
  const tomorrow = today.add(1, 'day');

  // Skip weekends
  const dow = today.day();
  if (dow === 0 || dow === 6) {
    return NextResponse.json({ message: 'Weekend — no reminders sent', sent: 0 });
  }

  // Get all active employees
  const allEmployees = await db
    .select({ id: users.id, fullName: users.fullName, email: users.email })
    .from(users)
    .where(and(eq(users.isActive, true), eq(users.role, 'employee')));

  // Find who has entered time today
  const entriesForToday = await db
    .select({ userId: timesheetEntries.userId })
    .from(timesheetEntries)
    .where(
      and(
        gte(timesheetEntries.entryDate, today.toDate()),
        lt(timesheetEntries.entryDate, tomorrow.toDate()),
      )
    );

  const usersWithEntries = new Set(entriesForToday.map((e) => e.userId));

  let sent = 0;
  for (const emp of allEmployees) {
    if (usersWithEntries.has(emp.id)) continue; // Already entered time

    // Check notification preference
    const prefs = await db
      .select({ enabled: notificationPreferences.emailDailyReminder })
      .from(notificationPreferences)
      .where(eq(notificationPreferences.userId, emp.id));

    const enabled = prefs.length === 0 ? true : prefs[0].enabled; // Default to enabled

    if (enabled) {
      await sendDailyReminderEmail({
        employeeEmail: emp.email,
        employeeName: emp.fullName,
        todayDate: today.format('dddd, MMM D, YYYY'),
      });
      sent++;
    }
  }

  return NextResponse.json({ message: `Daily reminders sent`, sent });
}
```

#### G2. Create `src/app/api/cron/submission-deadline/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { users, timesheetPeriods, notificationPreferences } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import dayjs from 'dayjs';
import { sendSubmissionDeadlineEmail } from '@/lib/email/send';
import { getCurrentPeriodStart, getNumDaysInPeriod } from '@/lib/date-utils';

/**
 * Cron endpoint: Send submission deadline reminders.
 * Should be called daily. Sends reminders 2 days before and on the last day of each period.
 *
 * Protect this endpoint with a CRON_SECRET header in production.
 */
export async function GET(request: NextRequest) {
  const cronSecret = request.headers.get('x-cron-secret');
  if (process.env.CRON_SECRET && cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const today = dayjs().startOf('day');
  const periodStart = getCurrentPeriodStart();
  const numDays = getNumDaysInPeriod(periodStart);
  const periodEnd = dayjs(periodStart).add(numDays - 1, 'day');
  const daysUntilEnd = periodEnd.diff(today, 'day');

  // Only send reminders 2 days before and on the last day
  if (daysUntilEnd !== 2 && daysUntilEnd !== 0) {
    return NextResponse.json({ message: 'Not a reminder day', sent: 0 });
  }

  const periodLabel = `${dayjs(periodStart).format('MMM D')} – ${periodEnd.format('MMM D, YYYY')}`;
  const deadlineDate = periodEnd.format('dddd, MMM D, YYYY');

  // Get all active employees
  const allEmployees = await db
    .select({ id: users.id, fullName: users.fullName, email: users.email })
    .from(users)
    .where(and(eq(users.isActive, true), eq(users.role, 'employee')));

  let sent = 0;
  for (const emp of allEmployees) {
    // Check if this user has a submitted/approved period
    const periods = await db
      .select({ status: timesheetPeriods.status })
      .from(timesheetPeriods)
      .where(
        and(
          eq(timesheetPeriods.userId, emp.id),
          eq(timesheetPeriods.periodStart, periodStart),
        )
      );

    const period = periods[0];
    if (period && (period.status === 'submitted' || period.status === 'approved')) {
      continue; // Already submitted or approved
    }

    // Check notification preference
    const prefs = await db
      .select({ enabled: notificationPreferences.emailDeadlineReminder })
      .from(notificationPreferences)
      .where(eq(notificationPreferences.userId, emp.id));

    const enabled = prefs.length === 0 ? true : prefs[0].enabled;

    if (enabled) {
      await sendSubmissionDeadlineEmail({
        employeeEmail: emp.email,
        employeeName: emp.fullName,
        periodLabel,
        deadlineDate,
      });
      sent++;
    }
  }

  return NextResponse.json({ message: 'Submission deadline reminders sent', sent });
}
```

---

### Phase H: Notification Settings UI (H1–H2)

#### H1. Create notification settings page and client (simplified)

Create `src/app/(app)/admin/notifications/page.tsx` and `NotificationsClient.tsx` with a simple form showing toggle switches for each notification type. This page is available to all authenticated users (not just admins) — each user manages their own preferences.

Alternatively, add notification settings to the Profile page (from the Password Management blueprint) as a new section.

The client component should:
- Fetch current preferences via `getNotificationPreferences(userId)`
- Render a `Switch` for each notification type
- Call `updateNotificationPreferences()` on each toggle change
- Show a success notification after each save

#### H2. Add navigation link

Add a "Notification Settings" link to the user's profile dropdown menu in `AppHeader.tsx`, similar to the "Change Password" link.

---

## 4. Verification

### 4a. Build Check

```bash
npx drizzle-kit push
npm run build
```

Must complete with **zero errors**.

### 4b. Functional Checks (with RESEND_API_KEY configured)

| Check | Expected Result |
|---|---|
| **Submit timesheet** | Supervisor receives email with "Timesheet Submitted" subject |
| **Approve timesheet** | Employee receives email with "Timesheet Approved" subject |
| **Reject timesheet** | Employee receives email with rejection comment |
| **Hit daily reminder cron endpoint** | Employees without today's entries receive reminder email |
| **Hit submission deadline cron (last day of period)** | Employees with draft timesheets receive deadline email |
| **Disable notification preference** | Email not sent for disabled notification types |
| **No RESEND_API_KEY set** | Graceful fallback — no emails sent, no errors |

### 4c. Functional Checks (without RESEND_API_KEY — dev mode)

| Check | Expected Result |
|---|---|
| **All actions work normally** | Submit/approve/reject complete without errors |
| **Console shows warning** | "RESEND_API_KEY not set — email notifications will be disabled" |
| **No emails sent** | `isEmailEnabled()` returns false; all send functions return immediately |

### 4d. Cron Endpoint Security

| Check | Expected Result |
|---|---|
| **Call cron without secret (CRON_SECRET set)** | Returns 401 Unauthorized |
| **Call cron with correct secret** | Returns 200 with send count |
| **Call cron without CRON_SECRET env var set** | Endpoint is open (no auth check) |

### 4e. Common Errors to Watch For

| Error | Root Cause | Fix |
|---|---|---|
| `Resend is not a constructor` | Package not installed | Run `npm install resend` |
| Email not delivered | Resend API key invalid or domain not verified | Check Resend dashboard for delivery logs |
| `@react-email/components` import error | Package not installed | Run `npm install @react-email/components` |
| `notificationPreferences` table missing | Schema not pushed | Run `npx drizzle-kit push` |
| Cron endpoint accessible without auth | No CRON_SECRET set | Set `CRON_SECRET` in `.env.local` for production |
| Fire-and-forget email blocks action | Using `await` on send function | Remove `await` — let the email send asynchronously |
| Too many emails on submit | All supervisors notified | Expected behavior for MVP; future: scope to relevant supervisors only |
