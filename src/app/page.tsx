import { Container, Title, Text, Button, Group, Stack, Paper, SimpleGrid, ThemeIcon, Badge, Divider, Center, Anchor, VisuallyHidden } from '@mantine/core';
import { IconClock, IconShieldCheck, IconCloudLock, IconReportAnalytics, IconUsers, IconDeviceFloppy, IconApi, IconMoon } from '@tabler/icons-react';
import React from 'react';
import { redirect } from 'next/navigation';
import { Logo } from '@/components/brand/Logo';
import { ROLE_COLOR } from '@/lib/ui/status-colors';
import { getTenantSlug } from '@/lib/tenant/context';
import { getSessionUser } from '@/lib/session';
import { landingPath } from '@/components/shell/nav-config';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: { absolute: 'CadenzPoint – DCAA-compliant timekeeping' } };

export const dynamic = 'force-dynamic';

export default async function LandingPage() {
  // feature-plan-launch-blockers.md P2: the marketing page is the APEX. On a workspace host, "/" is the app.
  let slug = '';
  try {
    slug = await getTenantSlug();
  } catch {
    slug = ''; // host/header mismatch: nothing workspace-specific to show — render the public page
  }
  // UX-2 §4.3 (UX-D3): on a workspace host, "/" sends people where they land — admins and supervisors to Home,
  // employees to Timesheet; no session → sign in. redirect() stays OUTSIDE the try above: it throws NEXT_REDIRECT,
  // which a catch-all would swallow (trap T-P).
  if (slug) {
    const user = await getSessionUser();
    if (!user) redirect('/login');
    redirect(landingPath(user.role));
  }

  // The demo lives on its own workspace; without a configured URL there is nothing to link to.
  const demoUrl = process.env.NEXT_PUBLIC_DEMO_URL || null;

  return (
    <Container component="main" size="lg" py="xl">
      <VisuallyHidden component="h1">CadenzPoint: DCAA-compliant timekeeping for government contractors</VisuallyHidden>
      {/* Hero Section */}
      <Center>
        <Stack align="center" gap="lg" py={60}>
          <Badge size="lg" variant="light" color="signal">DCAA Compliant</Badge>
          <Logo size="xl" />
          <Text size="xl" c="dimmed" ta="center" maw={600}>
            Modern, fault-tolerant timekeeping for Government Contractors.
            Replace Deltek, Unanet, and HourTimesheet with a superior experience.
          </Text>
          <Group mt="md">
            <Button component="a" href="/signup" size="lg" radius="md">
              Start Free Trial
            </Button>
            {demoUrl && (
              <Button component="a" href={demoUrl} size="lg" variant="default" radius="md">
                Try the Demo
              </Button>
            )}
            <Button component="a" href="#features" size="lg" variant="subtle" radius="md">
              See Features
            </Button>
          </Group>
        </Stack>
      </Center>

      <Divider my="xl" />

      {/* Demo Credentials — only when there is a demo workspace to use them on */}
      {demoUrl && (
        <Paper withBorder p="lg" radius="md" mb="xl">
          <Title order={2} size="h3" mb="md" ta="center">🎯 Demo Credentials</Title>
          <Text size="sm" c="dimmed" ta="center" mb="md">
            Try different roles to see the full experience. All accounts use password: <strong>Password123!</strong>
          </Text>
          <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="md">
            <Paper withBorder p="md" radius="md">
              <Badge color={ROLE_COLOR.admin} mb="xs">Admin</Badge>
              <Text size="sm" fw={600}>admin@cadenzpoint.dev</Text>
              <Text size="xs" c="dimmed">Full system access — manage users, contracts, approvals</Text>
            </Paper>
            <Paper withBorder p="md" radius="md">
              <Badge color={ROLE_COLOR.supervisor} mb="xs">Supervisor</Badge>
              <Text size="sm" fw={600}>sarah.wilson@cadenzpoint.dev</Text>
              <Text size="xs" c="dimmed">Review and approve employee timesheets</Text>
            </Paper>
            <Paper withBorder p="md" radius="md">
              <Badge color={ROLE_COLOR.employee} mb="xs">Employee</Badge>
              <Text size="sm" fw={600}>jane.smith@cadenzpoint.dev</Text>
              <Text size="xs" c="dimmed">Enter time, submit for approval, view dashboard</Text>
            </Paper>
          </SimpleGrid>
        </Paper>
      )}

      {/* Features Grid */}
      <div id="features">
        <Title order={2} ta="center" mb="xl">Built for DCAA Compliance</Title>
        <SimpleGrid cols={{ base: 1, sm: 2, md: 4 }} spacing="lg" mb="xl">
          <FeatureCard
            icon={<IconShieldCheck size={28} />}
            color="signal"
            title="Append-Only Audit Trail"
            description="Every change creates a new revision. Nothing is ever deleted or overwritten."
          />
          <FeatureCard
            icon={<IconClock size={28} />}
            color="ink"
            title="Daily Time Entry"
            description="Late entry detection, future-date prevention, and daily reminder emails."
          />
          <FeatureCard
            icon={<IconUsers size={28} />}
            color="ink"
            title="Granular RBAC"
            description="Employees only see CLINs they're assigned to. Server-side enforcement."
          />
          <FeatureCard
            icon={<IconDeviceFloppy size={28} />}
            color="ink"
            title="Digital Certification"
            description="DCAA-compliant submission with certification statement and supervisor approval."
          />
          <FeatureCard
            icon={<IconCloudLock size={28} />}
            color="ink"
            title="Offline Support"
            description="Log time without internet. Syncs automatically when connection returns."
          />
          <FeatureCard
            icon={<IconReportAnalytics size={28} />}
            color="ink"
            title="Reports & Export"
            description="PDF timesheets, CSV/Excel cost reports, employee summaries."
          />
          <FeatureCard
            icon={<IconApi size={28} />}
            color="ink"
            title="REST API"
            description="API key-authenticated endpoints for accounting system integration."
          />
          <FeatureCard
            icon={<IconMoon size={28} />}
            color="ink"
            title="Dark Mode"
            description="Beautiful dark and light themes with seamless switching."
          />
        </SimpleGrid>
      </div>

      <Divider my="xl" />

      {/* Tech Stack */}
      <Paper withBorder p="lg" radius="md" mb="xl">
        <Title order={3} mb="md" ta="center">Tech Stack</Title>
        <Group justify="center" gap="lg" wrap="wrap">
          <Badge size="lg" variant="light">Next.js 16</Badge>
          <Badge size="lg" variant="light">Mantine v9</Badge>
          <Badge size="lg" variant="light">PostgreSQL</Badge>
          <Badge size="lg" variant="light">Drizzle ORM</Badge>
          <Badge size="lg" variant="light">Auth.js v5</Badge>
          <Badge size="lg" variant="light">TypeScript</Badge>
          <Badge size="lg" variant="light">Vitest</Badge>
        </Group>
      </Paper>

      {/* CTA */}
      <Center py="xl">
        <Stack align="center" gap="md">
          <Title order={3}>Ready to try it?</Title>
          <Group>
            <Button component="a" href="/signup" size="lg" radius="md">
              Start Free Trial →
            </Button>
            {demoUrl && (
              <Button component="a" href={demoUrl} size="lg" variant="default" radius="md">
                Launch Demo
              </Button>
            )}
          </Group>
        </Stack>
      </Center>

      {/* Footer */}
      <Divider my="xl" />
      <Stack align="center" gap={4} pb="xl">
        <Text size="xs" c="dimmed" ta="center">
          © 2026 CadenzPoint — DCAA-Compliant Timekeeping for Government Contractors
        </Text>
        <Group gap="md">
          <Anchor href="/terms" size="xs" c="dimmed">Terms of Service</Anchor>
          <Anchor href="/privacy" size="xs" c="dimmed">Privacy Policy</Anchor>
        </Group>
      </Stack>
    </Container>
  );
}

function FeatureCard({ icon, color, title, description }: {
  icon: React.ReactNode;
  color: string;
  title: string;
  description: string;
}) {
  return (
    <Paper withBorder p="md" radius="md">
      <ThemeIcon size="lg" radius="md" variant="light" color={color} mb="sm">
        {icon}
      </ThemeIcon>
      <Text fw={600} size="sm" mb={4}>{title}</Text>
      <Text size="xs" c="dimmed">{description}</Text>
    </Paper>
  );
}
