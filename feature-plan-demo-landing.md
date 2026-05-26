# Blueprint: Demo Landing Page — Public Product Showcase

## 1. Architectural Overview

### The Problem

When someone visits `bytime.vercel.app`, they're immediately redirected to `/login` with no context about what the product is. For a demo/prospect scenario, visitors need to understand what ByTime is before they create an account or try the demo.

### The Solution

Create a **public landing page** at `/` that:
- Showcases the product with a hero section
- Lists key features with icons
- Displays demo credentials so visitors can try immediately
- Has a prominent "Try the Demo" button linking to `/login`
- Does NOT require authentication (public route)

### Design

The landing page uses Mantine components exclusively (consistent with the rest of the app) and supports dark/light mode. It's a single-page static component — no database queries, no server actions.

---

## 2. File Topology

```
Files to CREATE:
├── src/app/(public)/
│   └── page.tsx                                     ← Public landing page (Server Component)

Files to MODIFY:
├── src/app/page.tsx                                  ← Change redirect to render landing page
├── src/middleware.ts                                 ← Ensure / is NOT protected by auth

Files NOT TOUCHED:
├── src/app/(app)/**                                  ← ❌ DO NOT MODIFY
├── src/app/login/**                                  ← ❌ DO NOT MODIFY
├── src/components/**                                 ← ❌ DO NOT MODIFY
├── src/server/**                                     ← ❌ DO NOT MODIFY
├── src/db/**                                         ← ❌ DO NOT MODIFY
```

---

## 3. Step-by-Step Execution Plan

> **⚠️ CRITICAL GUARDRAILS:**
> - **DO NOT** modify any authenticated app code.
> - The landing page must be **fully public** — no auth required.
> - Use **Mantine v9** components only.
> - **After each phase, run `npm run build` to verify zero errors.**

---

### Phase A: Update Root Page (A1)

#### A1. Modify `src/app/page.tsx` — Replace redirect with landing page

The current file is:
```tsx
import { redirect } from 'next/navigation';
export default function Home() { redirect('/timesheet'); }
```

Replace with a landing page component. Since the root layout already has `MantineProvider`, Mantine components work here.

```tsx
import { Container, Title, Text, Button, Group, Stack, Paper, SimpleGrid, ThemeIcon, Badge, Divider, Center, Anchor } from '@mantine/core';
import { IconClock, IconShieldCheck, IconCloudLock, IconReportAnalytics, IconUsers, IconDeviceFloppy, IconApi, IconMoon } from '@tabler/icons-react';

export default function LandingPage() {
  return (
    <Container size="lg" py="xl">
      {/* Hero Section */}
      <Center>
        <Stack align="center" gap="lg" py={60}>
          <Badge size="lg" variant="light" color="blue">DCAA Compliant</Badge>
          <Title order={1} ta="center" size={48}>
            ByTime
          </Title>
          <Text size="xl" c="dimmed" ta="center" maw={600}>
            Modern, fault-tolerant timekeeping for Government Contractors.
            Replace Deltek, Unanet, and HourTimesheet with a superior experience.
          </Text>
          <Group mt="md">
            <Button component="a" href="/login" size="lg" radius="md">
              Try the Demo
            </Button>
            <Button component="a" href="#features" size="lg" variant="default" radius="md">
              See Features
            </Button>
          </Group>
        </Stack>
      </Center>

      <Divider my="xl" />

      {/* Demo Credentials */}
      <Paper withBorder p="lg" radius="md" mb="xl">
        <Title order={3} mb="md" ta="center">🎯 Demo Credentials</Title>
        <Text size="sm" c="dimmed" ta="center" mb="md">
          Try different roles to see the full experience. All accounts use password: <strong>Password123!</strong>
        </Text>
        <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="md">
          <Paper withBorder p="md" radius="md">
            <Badge color="red" mb="xs">Admin</Badge>
            <Text size="sm" fw={600}>admin@bytime.dev</Text>
            <Text size="xs" c="dimmed">Full system access — manage users, contracts, approvals</Text>
          </Paper>
          <Paper withBorder p="md" radius="md">
            <Badge color="blue" mb="xs">Supervisor</Badge>
            <Text size="sm" fw={600}>sarah.wilson@bytime.dev</Text>
            <Text size="xs" c="dimmed">Review and approve employee timesheets</Text>
          </Paper>
          <Paper withBorder p="md" radius="md">
            <Badge color="green" mb="xs">Employee</Badge>
            <Text size="sm" fw={600}>jane.smith@bytime.dev</Text>
            <Text size="xs" c="dimmed">Enter time, submit for approval, view dashboard</Text>
          </Paper>
        </SimpleGrid>
      </Paper>

      {/* Features Grid */}
      <div id="features">
        <Title order={2} ta="center" mb="xl">Built for DCAA Compliance</Title>
        <SimpleGrid cols={{ base: 1, sm: 2, md: 4 }} spacing="lg" mb="xl">
          <FeatureCard
            icon={<IconShieldCheck size={28} />}
            color="blue"
            title="Append-Only Audit Trail"
            description="Every change creates a new revision. Nothing is ever deleted or overwritten."
          />
          <FeatureCard
            icon={<IconClock size={28} />}
            color="green"
            title="Daily Time Entry"
            description="Late entry detection, future-date prevention, and daily reminder emails."
          />
          <FeatureCard
            icon={<IconUsers size={28} />}
            color="grape"
            title="Granular RBAC"
            description="Employees only see CLINs they're assigned to. Server-side enforcement."
          />
          <FeatureCard
            icon={<IconDeviceFloppy size={28} />}
            color="orange"
            title="Digital Certification"
            description="DCAA-compliant submission with certification statement and supervisor approval."
          />
          <FeatureCard
            icon={<IconCloudLock size={28} />}
            color="cyan"
            title="Offline Support"
            description="Log time without internet. Syncs automatically when connection returns."
          />
          <FeatureCard
            icon={<IconReportAnalytics size={28} />}
            color="red"
            title="Reports & Export"
            description="PDF timesheets, CSV/Excel cost reports, employee summaries."
          />
          <FeatureCard
            icon={<IconApi size={28} />}
            color="indigo"
            title="REST API"
            description="API key-authenticated endpoints for accounting system integration."
          />
          <FeatureCard
            icon={<IconMoon size={28} />}
            color="yellow"
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
          <Button component="a" href="/login" size="lg" radius="md">
            Launch Demo →
          </Button>
        </Stack>
      </Center>

      {/* Footer */}
      <Divider my="xl" />
      <Text size="xs" c="dimmed" ta="center" pb="xl">
        © 2026 ByTime — DCAA-Compliant Timekeeping for Government Contractors
      </Text>
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
```

---

### Phase B: Ensure Root Route is Public (B1)

#### B1. Verify `src/middleware.ts` does NOT protect `/`

The current middleware matcher should only protect `/timesheet/*` and `/admin/*`:

```typescript
export const config = {
  matcher: [
    '/timesheet/:path*',
    '/admin/:path*',
  ],
};
```

The root `/` is NOT in the matcher, so it's already public. **No changes needed** — just verify.

If the middleware currently matches `/`, remove it from the matcher.

---

## 4. Verification

### 4a. Build Check

```bash
npm run build
```

### 4b. Landing Page Checks

| Check | Expected |
|---|---|
| Visit `/` | Landing page renders (not redirect to /login) |
| "Try the Demo" button | Links to `/login` |
| Demo credentials visible | 3 role cards with emails |
| Feature cards render | 8 feature cards with icons |
| Dark mode | Landing page respects color scheme |
| Mobile responsive | Cards stack vertically on small screens |
| Login still works | `/login` page unchanged |
| Authenticated routes still protected | `/timesheet` redirects to `/login` if not logged in |

### 4c. Common Errors

| Error | Fix |
|---|---|
| Root page protected by middleware | Verify matcher doesn't include `/` |
| Mantine components unstyled | Root layout already has MantineProvider — should work |
| Hydration mismatch | Landing page is a Server Component (no `'use client'`) — no hydration issues |
