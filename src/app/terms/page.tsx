import { Container, Title, Text, Stack, Anchor, Divider } from '@mantine/core';
import { IconArrowLeft } from '@tabler/icons-react';

export default function TermsPage() {
  return (
    <Container size="md" py="xl">
      <Anchor href="/" size="sm" mb="lg" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <IconArrowLeft size={14} /> Back to Home
      </Anchor>

      <Title order={1} mb="xl">Terms of Service</Title>

      <Stack gap="md">
        <Text size="sm" c="dimmed">Last updated: May 2026</Text>

        <Title order={3}>1. Acceptance of Terms</Title>
        <Text>
          By accessing and using ByTime ("the Service"), you agree to be bound by these Terms of Service.
          If you do not agree to these terms, do not use the Service.
        </Text>

        <Title order={3}>2. Description of Service</Title>
        <Text>
          ByTime is a DCAA-compliant timekeeping application designed for Government Contractors.
          The Service enables time entry, approval workflows, audit trail management, and reporting
          in accordance with Defense Contract Audit Agency requirements.
        </Text>

        <Title order={3}>3. User Accounts</Title>
        <Text>
          You are responsible for maintaining the confidentiality of your account credentials.
          You must immediately notify your administrator of any unauthorized use of your account.
          Each user account is for individual use only and may not be shared.
        </Text>

        <Title order={3}>4. Data Ownership</Title>
        <Text>
          All timesheet data, contract information, and business records entered into the Service
          remain the property of the subscribing organization. ByTime does not claim ownership of
          your data and will not share it with third parties except as required by law.
        </Text>

        <Title order={3}>5. DCAA Compliance</Title>
        <Text>
          The Service is designed to facilitate DCAA compliance but does not guarantee audit outcomes.
          It is the responsibility of the subscribing organization to ensure that their timekeeping
          practices meet all applicable federal regulations, including FAR 31.201-1, CAS 418, and
          DCAA timekeeping guidelines.
        </Text>

        <Title order={3}>6. Data Security</Title>
        <Text>
          We implement industry-standard security measures including encryption in transit (TLS),
          hashed passwords (bcrypt), session management, and brute force protection.
          Timesheet data is stored using an append-only architecture that preserves the complete
          audit trail as required by DCAA.
        </Text>

        <Title order={3}>7. Service Availability</Title>
        <Text>
          We strive to maintain high availability but do not guarantee uninterrupted access.
          The Service includes offline support that allows users to continue logging time during
          temporary network outages.
        </Text>

        <Title order={3}>8. Limitation of Liability</Title>
        <Text>
          ByTime is provided "as is" without warranties of any kind. In no event shall ByTime
          be liable for any indirect, incidental, special, or consequential damages arising from
          use of the Service.
        </Text>

        <Title order={3}>9. Changes to Terms</Title>
        <Text>
          We may modify these terms at any time. Continued use of the Service after changes
          constitutes acceptance of the modified terms. Users will be notified of material changes
          via email.
        </Text>

        <Divider my="xl" />

        <Text size="xs" c="dimmed">
          Questions about these terms? Contact your system administrator.
        </Text>
      </Stack>
    </Container>
  );
}
