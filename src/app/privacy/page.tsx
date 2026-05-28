import { Container, Title, Text, Stack, Anchor, Divider } from '@mantine/core';
import { IconArrowLeft } from '@tabler/icons-react';

export default function PrivacyPage() {
  return (
    <Container size="md" py="xl">
      <Anchor href="/" size="sm" mb="lg" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <IconArrowLeft size={14} /> Back to Home
      </Anchor>

      <Title order={1} mb="xl">Privacy Policy</Title>

      <Stack gap="md">
        <Text size="sm" c="dimmed">Last updated: May 2026</Text>

        <Title order={3}>1. Information We Collect</Title>
        <Text>ByTime collects the following types of information:</Text>
        <Stack gap={4} pl="md">
          <Text size="sm">• <strong>Account information:</strong> Name, email address, role (provided by your administrator)</Text>
          <Text size="sm">• <strong>Timesheet data:</strong> Hours worked, charge codes, daily notes, submission/approval records</Text>
          <Text size="sm">• <strong>Authentication data:</strong> Hashed passwords, login timestamps, session information</Text>
          <Text size="sm">• <strong>Usage data:</strong> Login attempts (for security), page access patterns</Text>
        </Stack>

        <Title order={3}>2. How We Use Your Information</Title>
        <Text>Your information is used to:</Text>
        <Stack gap={4} pl="md">
          <Text size="sm">• Provide the timekeeping service to your organization</Text>
          <Text size="sm">• Authenticate your identity and manage your session</Text>
          <Text size="sm">• Generate reports and audit trails as required by DCAA</Text>
          <Text size="sm">• Send email notifications (configurable in your preferences)</Text>
          <Text size="sm">• Protect against unauthorized access and brute force attacks</Text>
        </Stack>

        <Title order={3}>3. Data Retention</Title>
        <Text>
          Timesheet entries are retained indefinitely using an append-only architecture.
          This is a DCAA requirement — historical records cannot be deleted or modified.
          Your organization's administrator controls the retention of all other data.
        </Text>

        <Title order={3}>4. Data Sharing</Title>
        <Text>
          We do not sell, trade, or share your personal information with third parties.
          Your data may be accessed by your organization's administrators and supervisors
          as permitted by their role-based access controls. Data may be disclosed if required
          by law, court order, or government audit.
        </Text>

        <Title order={3}>5. Security</Title>
        <Text>We protect your data with:</Text>
        <Stack gap={4} pl="md">
          <Text size="sm">• TLS encryption for all data in transit</Text>
          <Text size="sm">• Bcrypt password hashing (never stored in plaintext)</Text>
          <Text size="sm">• Brute force protection with account lockout</Text>
          <Text size="sm">• Session invalidation on password change or role modification</Text>
          <Text size="sm">• API key authentication with SHA-256 hashing for integrations</Text>
        </Stack>

        <Title order={3}>6. Your Rights</Title>
        <Text>
          You can view your personal information in your Profile page. To request data export
          or account deletion, contact your organization's system administrator. Note that
          DCAA compliance requirements may prevent deletion of timesheet records.
        </Text>

        <Title order={3}>7. Cookies and Local Storage</Title>
        <Text>
          ByTime uses HTTP-only session cookies for authentication. The offline support feature
          stores timesheet data in your browser's IndexedDB for sync purposes. No third-party
          tracking cookies are used.
        </Text>

        <Title order={3}>8. Changes to This Policy</Title>
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
