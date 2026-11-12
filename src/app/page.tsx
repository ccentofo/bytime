import { Container, Title, Text, Button, Group, Stack, Paper, SimpleGrid, ThemeIcon, Badge, Divider, Anchor } from '@mantine/core';
import React from 'react';
import { redirect } from 'next/navigation';
import { Logo } from '@/components/brand/Logo';
import { ProductPreview } from '@/components/marketing/ProductPreview';
import { Icons } from '@/components/ui/icons';
import { ROLE_COLOR } from '@/lib/ui/status-colors';
import { getTenantSlug } from '@/lib/tenant/context';
import { getSessionUser } from '@/lib/session';
import { landingPath } from '@/components/shell/nav-config';
import {
  LANDING_BADGE,
  LANDING_FEATURES,
  LANDING_FEATURES_HEADING,
  LANDING_FOOTER_DISCLAIMER,
  LANDING_HEADLINE,
  LANDING_SUBHEAD,
} from '@/lib/marketing/landing-copy';
import styles from './page.module.css';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: { absolute: 'CadenzPoint – DCAA-compliant timekeeping' } };

export const dynamic = 'force-dynamic';

/** One icon per feature, in LANDING_FEATURES order (decorative). */
const FEATURE_ICONS = [Icons.history, Icons.timeEntry, Icons.users, Icons.approve, Icons.reports, Icons.integrations];

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

  // feature-plan-ux-integrations-billing.md L1, L2, §4: the copy comes from landing-copy.ts (BUSINESS-DECISIONS.md §2).
  // "Sign in" goes to the apex /login ("Find your workspace"). No Pricing yet (it arrives with per-user billing).
  return (
    <>
      <a href="#main-content" className={styles.skip}>Skip to main content</a>
      <header className={styles.header}>
        <Container size="lg" className={styles.headerInner}>
          <Anchor href="/" aria-label="CadenzPoint home" underline="never"><Logo size="md" /></Anchor>
          <Group component="nav" aria-label="Site" gap="md" wrap="nowrap">
            <Anchor href="#features" size="sm" c="var(--mantine-color-text)" visibleFrom="sm">Features</Anchor>
            {demoUrl && <Anchor href={demoUrl} size="sm" c="var(--mantine-color-text)" visibleFrom="sm">Try the demo</Anchor>}
            <Anchor href="/login" size="sm" fw={600}>Sign in</Anchor>
            <Button component="a" href="/signup" size="sm" radius="md">Start free trial</Button>
          </Group>
        </Container>
      </header>

      <Container component="main" id="main-content" tabIndex={-1} size="lg" py="xl">
        {/* Hero */}
        <SimpleGrid cols={{ base: 1, md: 2 }} spacing="xl" py={48} style={{ alignItems: 'center' }}>
          <Stack gap="md" align="flex-start">
            <Badge size="lg" variant="light" color="signal">{LANDING_BADGE}</Badge>
            <Title order={1}>{LANDING_HEADLINE}</Title>
            <Text size="lg" c="dimmed">{LANDING_SUBHEAD}</Text>
            <Group mt="xs">
              <Button component="a" href="/signup" size="lg" radius="md">Start free trial</Button>
              {demoUrl && (
                <Button component="a" href={demoUrl} size="lg" variant="default" radius="md">Try the demo</Button>
              )}
            </Group>
            <Text size="sm" c="dimmed">
              Already have a workspace? <Anchor href="/login" size="sm" fw={600}>Sign in</Anchor>
            </Text>
          </Stack>
          <ProductPreview />
        </SimpleGrid>

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

        {/* Features */}
        <section id="features" className={styles.features} aria-labelledby="features-heading">
          <Title order={2} id="features-heading" ta="center" mb="xl">{LANDING_FEATURES_HEADING}</Title>
          <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="lg" mb="xl">
            {LANDING_FEATURES.map((f, i) => {
              const Icon = FEATURE_ICONS[i];
              return (
                <Paper key={f.title} withBorder p="md" radius="md">
                  <ThemeIcon size="lg" radius="md" variant="light" color={i === 0 ? 'signal' : 'ink'} mb="sm">
                    <Icon size={22} aria-hidden="true" />
                  </ThemeIcon>
                  <Title order={3} size="h5" mb={4}>{f.title}</Title>
                  <Text size="sm" c="dimmed">{f.blurb}</Text>
                </Paper>
              );
            })}
          </SimpleGrid>
        </section>

        {/* Final call to action */}
        <Stack align="center" gap="md" py="xl">
          <Title order={2} size="h3">Ready to try it?</Title>
          <Group>
            <Button component="a" href="/signup" size="lg" radius="md">Start free trial</Button>
            {demoUrl && (
              <Button component="a" href={demoUrl} size="lg" variant="default" radius="md">Try the demo</Button>
            )}
          </Group>
        </Stack>
      </Container>

      <Container component="footer" size="lg" pb="xl">
        <Divider mb="lg" />
        <Stack align="center" gap={6}>
          <Text size="xs" c="dimmed" ta="center" maw={680}>{LANDING_FOOTER_DISCLAIMER}</Text>
          <Text size="xs" c="dimmed" ta="center">© 2026 CadenzPoint</Text>
          <Group gap="md">
            <Anchor href="/terms" size="xs" c="dimmed">Terms of Service</Anchor>
            <Anchor href="/privacy" size="xs" c="dimmed">Privacy Policy</Anchor>
            <Anchor href="/login" size="xs" c="dimmed">Sign in</Anchor>
          </Group>
        </Stack>
      </Container>
    </>
  );
}
