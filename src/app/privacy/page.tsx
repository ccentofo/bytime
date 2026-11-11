import { Container, Title, Text, Stack, Anchor, Divider } from '@mantine/core';
import { IconArrowLeft } from '@tabler/icons-react';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Privacy policy' };

export default function PrivacyPage() {
  return (
    <Container component="main" size="md" py="xl">
      <Anchor href="/" size="sm" mb="lg" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <IconArrowLeft size={14} /> Back to Home
      </Anchor>

      <Title order={1} mb="xl">Privacy Policy</Title>

      <Stack gap="md">
        <Text size="sm" c="dimmed">Last updated: November 2026</Text>

        <Title order={2} size="h3">1. Information We Collect</Title>
        <Text>CadenzPoint collects the following types of information:</Text>
        <Stack gap={4} pl="md">
          <Text size="sm">• <strong>Account information:</strong> Name, email address, role (provided by your administrator)</Text>
          <Text size="sm">• <strong>Timesheet data:</strong> Hours worked, charge codes, daily notes, submission/approval records</Text>
          <Text size="sm">• <strong>Authentication data:</strong> hashed passwords and multi-factor authentication settings (secrets are stored encrypted).</Text>
          <Text size="sm">• <strong>Security data:</strong> sign-in attempts (the email address used, the time, and whether it succeeded), used to block password guessing. To stop abuse, we keep a one-way, salted hash of the IP address used to sign up or sign in for up to 25 hours.</Text>
        </Stack>

        <Title order={2} size="h3">2. How We Use Your Information</Title>
        <Text>Your information is used to:</Text>
        <Stack gap={4} pl="md">
          <Text size="sm">• Provide the timekeeping service to your organization</Text>
          <Text size="sm">• Authenticate your identity and manage your session</Text>
          <Text size="sm">• Generate reports and audit trails as required by DCAA</Text>
          <Text size="sm">• Send email notifications (configurable in your preferences)</Text>
          <Text size="sm">• Protect against unauthorized access and brute force attacks</Text>
        </Stack>

        <Title order={2} size="h3">3. Data Retention</Title>
        <Text>
          Timesheet entries and their revision history are kept for as long as your organization subscribes. They
          are never overwritten or deleted during the subscription. When a free trial ends without a subscription,
          or a subscription ends, the workspace becomes read-only for 90 days so administrators can export their
          data. It is then permanently deleted, after at least 14 days&apos; email notice. Deleted data may remain in
          backups for up to 30 days. Signup records are deleted 7 days after signup if the email address is never
          verified, and otherwise 30 days after the workspace is set up or the signup is abandoned.
        </Text>

        <Title order={2} size="h3">4. Data Sharing</Title>
        <Text>We do not sell your personal information or share it for advertising. We share it only:</Text>
        <Stack gap={4} pl="md">
          <Text size="sm">• <strong>With service providers that run the Service for us:</strong> Vercel (hosting), Neon (databases), Amazon Web
            Services (encrypted backups), Resend (email), Stripe (payments), Sentry (error monitoring), Upstash
            (abuse prevention), and Cloudflare (bot protection on the signup page). Our application data is stored
            in the United States.</Text>
          <Text size="sm">• <strong>Within your organization:</strong> administrators and supervisors can see the time records their role
            permits.</Text>
          <Text size="sm">• <strong>With integrations your organization chooses to connect</strong>, such as QuickBooks Online.</Text>
          <Text size="sm">• <strong>When required by law, court order, or government audit.</strong></Text>
        </Stack>

        <Title order={2} size="h3">5. Security</Title>
        <Text>We protect your data with:</Text>
        <Stack gap={4} pl="md">
          <Text size="sm">• TLS encryption for all data in transit</Text>
          <Text size="sm">• Bcrypt password hashing (never stored in plaintext)</Text>
          <Text size="sm">• Brute force protection with account lockout</Text>
          <Text size="sm">• Session invalidation on password change or role modification</Text>
          <Text size="sm">• API key authentication with SHA-256 hashing for integrations</Text>
        </Stack>

        <Title order={2} size="h3">6. Your Rights</Title>
        <Text>
          You can view your personal information in your Profile page. To request data export
          or account deletion, contact your organization's system administrator. Note that
          DCAA compliance requirements may prevent deletion of timesheet records.
        </Text>

        <Title order={2} size="h3">7. Cookies and Browser Storage</Title>
        <Text>
          CadenzPoint uses only the cookies and browser storage needed for the Service to work. We do not use
          advertising or analytics cookies.
        </Text>
        <Stack gap={4} pl="md">
          <Text size="sm">• <strong>Sign-in cookies:</strong> HTTP-only cookies keep you signed in (for up to 24 hours) and protect against
            cross-site request forgery.</Text>
          <Text size="sm">• <strong>Preferences:</strong> a cookie and your browser&apos;s local storage remember display choices, such as the menu
            layout, light or dark theme, your last-used payroll export format, and notices you&apos;ve dismissed. They
            contain no timesheet data.</Text>
          <Text size="sm">• <strong>Unsaved timesheet edits:</strong> while you edit a timesheet, your unsaved changes are kept in your browser&apos;s
            session storage for that tab, so a page reload doesn&apos;t lose them. They stay on your device until you
            save, and your browser erases them when you close the tab.</Text>
          <Text size="sm">• <strong>Signup protection:</strong> the signup page uses Cloudflare Turnstile, which processes your IP address and
            browser information to tell people from bots.</Text>
        </Stack>

        <Title order={2} size="h3">8. Changes to This Policy</Title>
        <Text>
          We may update this Privacy Policy from time to time. Users will be notified of material
          changes via email. Continued use of the Service after changes constitutes acceptance.
        </Text>

        <Divider my="xl" />

        <Text size="xs" c="dimmed">
          Questions about privacy? Contact your system administrator.
        </Text>
      </Stack>
    </Container>
  );
}
