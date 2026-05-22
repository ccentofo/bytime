# Blueprint: Unified App Shell & Navigation

## 1. Architectural Overview

### The Problem

The application currently has three disconnected experiences:

- **`/`** — Default Next.js boilerplate (no branding, no purpose)
- **`/timesheet`** — Has its own ad-hoc header (Avatar + "ByTime" title) baked into `BiWeeklyTimesheetClient.tsx`
- **`/admin/*`** — Has its own standalone `AppShell` with a sidebar in `src/app/admin/layout.tsx`

There is no way for a user to navigate between sections. The app feels like 3 separate products.

### The Solution

Introduce a **unified Mantine `AppShell`** that wraps all authenticated pages. This provides:

1. **Global Header** — Logo + "ByTime" branding on the left, color scheme toggle on the right
2. **Left Navbar** — Persistent navigation links to Timesheet and Admin sections, with active-link highlighting based on current route
3. **Consistent content area** — All page content renders inside `AppShell.Main`

### Architectural Approach: Route Groups

We use a **Next.js route group** `(app)` to wrap all pages that should have the shell. The root `layout.tsx` stays clean (just `MantineProvider`) — this prepares us for future auth pages (login, register) that should NOT have the app shell.

```
src/app/
├── layout.tsx                    ← Root layout (MantineProvider only, no shell)
├── page.tsx                      ← Redirect to /timesheet
├── (app)/
│   ├── layout.tsx                ← AppShell layout (header + navbar)
│   ├── timesheet/
│   │   └── page.tsx              ← Timesheet page (moved here)
│   ├── admin/
│   │   ├── contracts/
│   │   │   ├── page.tsx          ← Contracts page (moved here)
│   │   │   └── ContractsClient.tsx
│   │   ├── assignments/
│   │   │   ├── page.tsx          ← Assignments page (moved here)
│   │   │   └── AssignmentsClient.tsx
```

Route groups (`(app)`) don't affect the URL — `/timesheet` and `/admin/contracts` still work as before. The `(app)/layout.tsx` wraps them all with the shared AppShell.

---

## 2. File Topology

```
Files to CREATE:
├── src/app/(app)/
│   ├── layout.tsx                                ← Unified AppShell layout (header + navbar + main)
│   ├── timesheet/
│   │   └── page.tsx                              ← Moved from src/app/timesheet/page.tsx
│   ├── admin/
│   │   ├── contracts/
│   │   │   ├── page.tsx                          ← Moved from src/app/admin/contracts/page.tsx
│   │   │   └── ContractsClient.tsx               ← Moved from src/app/admin/contracts/ContractsClient.tsx
│   │   ├── assignments/
│   │       ├── page.tsx                          ← Moved from src/app/admin/assignments/page.tsx
│   │       └── AssignmentsClient.tsx             ← Moved from src/app/admin/assignments/AssignmentsClient.tsx
│
├── src/components/shell/
│   ├── AppHeader.tsx                             ← Header component (logo + branding + color toggle)
│   └── AppNavbar.tsx                             ← Navbar component (nav links with active state)

Files to MODIFY:
├── src/app/page.tsx                              ← Replace boilerplate with redirect to /timesheet
├── src/app/layout.tsx                            ← Keep clean: MantineProvider only (no AppShell)
├── src/components/timesheet/BiWeeklyTimesheetClient.tsx  ← Remove duplicate header (Avatar + Title)

Files to DELETE:
├── src/app/timesheet/page.tsx                    ← Replaced by src/app/(app)/timesheet/page.tsx
├── src/app/admin/layout.tsx                      ← Replaced by src/app/(app)/layout.tsx
├── src/app/admin/contracts/page.tsx              ← Replaced by src/app/(app)/admin/contracts/page.tsx
├── src/app/admin/contracts/ContractsClient.tsx   ← Replaced by src/app/(app)/admin/contracts/ContractsClient.tsx
├── src/app/admin/assignments/page.tsx            ← Replaced by src/app/(app)/admin/assignments/page.tsx
├── src/app/admin/assignments/AssignmentsClient.tsx ← Replaced by src/app/(app)/admin/assignments/AssignmentsClient.tsx
├── src/app/page.module.css                       ← No longer needed (boilerplate styles)

Files NOT TOUCHED (guardrail — DO NOT MODIFY):
├── src/components/timesheet/BiWeeklyTable.tsx           ← ❌ DO NOT MODIFY
├── src/components/timesheet/TimesheetContext.tsx         ← ❌ DO NOT MODIFY
├── src/components/timesheet/PayPeriodSelector.tsx        ← ❌ DO NOT MODIFY
├── src/components/timesheet/DailyNoteModal.tsx           ← ❌ DO NOT MODIFY
├── src/components/timesheet/cells/*                      ← ❌ DO NOT MODIFY
├── src/data/mock-timesheet.ts                            ← ❌ DO NOT MODIFY
├── src/types/timesheet.ts                                ← ❌ DO NOT MODIFY
├── src/db/*                                              ← ❌ DO NOT MODIFY
├── src/server/actions/*                                  ← ❌ DO NOT MODIFY
```

---

## 3. Step-by-Step Execution Plan

> **⚠️ CRITICAL GUARDRAILS FOR THE EXECUTION AGENT:**
> - **DO NOT** search, grep, or read files inside `node_modules/`, `.next/`, or `dist/`.
> - **DO NOT** read documentation files or search for library docs.
> - **DO NOT** modify any files listed in the "NOT TOUCHED" section above.
> - Use **Mantine v9** imports only (`@mantine/core`, `@mantine/hooks`).
> - Use `@tabler/icons-react` for all icons.
> - The only modification allowed to the timesheet components is removing the duplicate header from `BiWeeklyTimesheetClient.tsx`.
> - Follow the step order exactly. Each step builds on the previous one.
> - After completing each step, pause and confirm with the user before continuing.

---

### Step 1: Create the Shell Components

These are pure presentational components with no server-side data fetching.

**1a.** Create `src/components/shell/AppHeader.tsx`:

```tsx
'use client';

import { Group, Title, Avatar, ActionIcon, useMantineColorScheme } from '@mantine/core';
import { IconSun, IconMoon } from '@tabler/icons-react';

export function AppHeader() {
  const { colorScheme, toggleColorScheme } = useMantineColorScheme();

  return (
    <Group h="100%" px="md" justify="space-between">
      <Group gap="sm">
        <Avatar src="/logo.png" size="md" radius="sm" />
        <Title order={3}>ByTime</Title>
      </Group>
      <ActionIcon
        variant="subtle"
        size="lg"
        onClick={toggleColorScheme}
        aria-label="Toggle color scheme"
      >
        {colorScheme === 'dark' ? <IconSun size={20} /> : <IconMoon size={20} />}
      </ActionIcon>
    </Group>
  );
}
```

**Key details:**
- Logo uses `src="/logo.png"` (file exists in `public/logo.png`).
- Color scheme toggle uses `useMantineColorScheme()` from Mantine v9.
- No database calls, no server actions.

**1b.** Create `src/components/shell/AppNavbar.tsx`:

```tsx
'use client';

import { Stack, NavLink, Divider, Text } from '@mantine/core';
import { IconClock, IconFileText, IconUsers } from '@tabler/icons-react';
import { usePathname } from 'next/navigation';

export function AppNavbar() {
  const pathname = usePathname();

  return (
    <Stack gap={0} pt="sm">
      {/* Employee Section */}
      <Text size="xs" fw={700} c="dimmed" px="md" mb={4}>
        TIMEKEEPING
      </Text>
      <NavLink
        label="My Timesheet"
        href="/timesheet"
        leftSection={<IconClock size={18} />}
        active={pathname === '/timesheet'}
      />

      <Divider my="sm" />

      {/* Admin Section */}
      <Text size="xs" fw={700} c="dimmed" px="md" mb={4}>
        ADMINISTRATION
      </Text>
      <NavLink
        label="Contracts & CLINs"
        href="/admin/contracts"
        leftSection={<IconFileText size={18} />}
        active={pathname === '/admin/contracts'}
      />
      <NavLink
        label="User Assignments"
        href="/admin/assignments"
        leftSection={<IconUsers size={18} />}
        active={pathname === '/admin/assignments'}
      />
    </Stack>
  );
}
```

**Key details:**
- Uses `usePathname()` from `next/navigation` for active-link highlighting.
- Navigation sections are separated by a `Divider` with section labels.
- NavLink `href` values are plain strings — these use standard anchor navigation (Mantine NavLink supports this).
- `active` prop is set by comparing current `pathname` to the link's `href`.

---

### Step 2: Create the Unified AppShell Layout

**2a.** Create `src/app/(app)/layout.tsx`:

```tsx
'use client';

import { AppShell } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { AppHeader } from '@/components/shell/AppHeader';
import { AppNavbar } from '@/components/shell/AppNavbar';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const [opened, { toggle }] = useDisclosure();

  return (
    <AppShell
      header={{ height: 60 }}
      navbar={{ width: 250, breakpoint: 'sm', collapsed: { mobile: !opened } }}
      padding="md"
    >
      <AppShell.Header>
        <AppHeader />
      </AppShell.Header>
      <AppShell.Navbar p="xs">
        <AppNavbar />
      </AppShell.Navbar>
      <AppShell.Main>{children}</AppShell.Main>
    </AppShell>
  );
}
```

**Key details:**
- This is the single layout that wraps both `/timesheet` and `/admin/*`.
- The `useDisclosure` hook is for future mobile burger menu support (navbar collapse).
- Header height is 60px. Navbar width is 250px.
- This replaces the old `src/app/admin/layout.tsx` entirely.

---

### Step 3: Move Existing Pages Into the Route Group

The goal is to move all authenticated pages from their current locations into the `(app)` route group. The URLs do NOT change — route groups are invisible in the URL.

**3a.** Create `src/app/(app)/timesheet/page.tsx`:

Copy the exact content from the current `src/app/timesheet/page.tsx`:

```tsx
import { BiWeeklyTimesheetClient } from '@/components/timesheet/BiWeeklyTimesheetClient';

export default function TimesheetPage() {
  return <BiWeeklyTimesheetClient />;
}
```

**3b.** Create `src/app/(app)/admin/contracts/page.tsx`:

Copy the exact content from the current `src/app/admin/contracts/page.tsx`:

```tsx
import { getContracts } from '@/server/actions/contracts';
import { ContractsClient } from './ContractsClient';

export const dynamic = 'force-dynamic';

export default async function ContractsPage() {
  const contracts = await getContracts();
  return <ContractsClient initialContracts={contracts} />;
}
```

**3c.** Create `src/app/(app)/admin/contracts/ContractsClient.tsx`:

Copy the exact content from the current `src/app/admin/contracts/ContractsClient.tsx` — no changes needed. This file is 366 lines. Copy it verbatim.

**3d.** Create `src/app/(app)/admin/assignments/page.tsx`:

Copy the exact content from the current `src/app/admin/assignments/page.tsx`:

```tsx
import { getAssignments } from '@/server/actions/assignments';
import { getUsers } from '@/server/actions/users';
import { getContracts } from '@/server/actions/contracts';
import { AssignmentsClient } from './AssignmentsClient';

export const dynamic = 'force-dynamic';

export default async function AssignmentsPage() {
  const [assignments, allUsers, allContracts] = await Promise.all([
    getAssignments(),
    getUsers(),
    getContracts(),
  ]);
  return (
    <AssignmentsClient
      initialAssignments={assignments}
      users={allUsers}
      contracts={allContracts}
    />
  );
}
```

**3e.** Create `src/app/(app)/admin/assignments/AssignmentsClient.tsx`:

Copy the exact content from the current `src/app/admin/assignments/AssignmentsClient.tsx` — no changes needed. This file is 217 lines. Copy it verbatim.

---

### Step 4: Delete the Old Route Files

Now that the pages live inside `(app)/`, delete the old locations to avoid conflicts. Next.js will error if two routes resolve to the same URL.

**Delete these files:**

1. `src/app/timesheet/page.tsx`
2. `src/app/admin/layout.tsx`
3. `src/app/admin/contracts/page.tsx`
4. `src/app/admin/contracts/ContractsClient.tsx`
5. `src/app/admin/assignments/page.tsx`
6. `src/app/admin/assignments/AssignmentsClient.tsx`

**Also delete the empty directories** if they are now empty:
- `src/app/timesheet/`
- `src/app/admin/contracts/`
- `src/app/admin/assignments/`
- `src/app/admin/`

**Also delete:**
7. `src/app/page.module.css` — the boilerplate CSS module is no longer needed.

---

### Step 5: Update the Home Page

**5a.** Replace the content of `src/app/page.tsx` with a redirect to `/timesheet`:

```tsx
import { redirect } from 'next/navigation';

export default function Home() {
  redirect('/timesheet');
}
```

This ensures that hitting `/` immediately takes the user to their timesheet. No boilerplate, no dead page.

---

### Step 6: Remove the Duplicate Header from BiWeeklyTimesheetClient

**6a.** Modify `src/components/timesheet/BiWeeklyTimesheetClient.tsx`:

**Remove** the `Avatar` and `Title` imports and the `<Group>` block that renders them. The AppShell header now handles branding.

The `TimesheetContent` function should change from:

```tsx
function TimesheetContent() {
  return (
    <Container fluid px="md" py="xl">
      <Group>
        <Avatar
        size="xl"
        src="/logo.png"/>
        <Title>ByTime</Title>
      </Group>
      <PayPeriodSelector />
      <Paper shadow="xs" p="md" radius="md" style={{ overflowX: 'auto' }}>
        <BiWeeklyTable />
      </Paper>
      <DailyNoteModal />
    </Container>
  );
}
```

To:

```tsx
function TimesheetContent() {
  return (
    <Container fluid px="md" py="xl">
      <PayPeriodSelector />
      <Paper shadow="xs" p="md" radius="md" style={{ overflowX: 'auto' }}>
        <BiWeeklyTable />
      </Paper>
      <DailyNoteModal />
    </Container>
  );
}
```

**Also update the imports** — remove `Avatar`, `Group`, and `Title` from the Mantine import since they're no longer used. Remove the unused `logo` import.

The import line should change from:

```tsx
import { Avatar, Container, Group, Paper, Title } from '@mantine/core';
```

To:

```tsx
import { Container, Paper } from '@mantine/core';
```

And remove this line entirely:

```tsx
import logo from '../../assets/logo.png';
```

---

### Step 7: Clean Up Root Layout

**7a.** Verify `src/app/layout.tsx` is clean — it should contain ONLY the `MantineProvider` wrapper and global styles. It must NOT contain an `AppShell`. The current file is already correct from our previous fix:

```tsx
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "@mantine/core/styles.css";
import "./globals.css";
import { MantineProvider, createTheme } from "@mantine/core";

const theme = createTheme({});

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ByTime — DCAA-Compliant Timekeeping",
  description: "Modern timekeeping for Government Contractors",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <head />
      <body>
        <MantineProvider defaultColorScheme="auto" theme={theme}>{children}</MantineProvider>
      </body>
    </html>
  );
}
```

**No changes needed** to this file. If it already looks like this, confirm and move on.

---

## 4. Verification

### 4a. Build Check

```bash
npm run build
```

Must complete with **zero errors**. Common issues to watch for:
- Duplicate route conflicts (if old files weren't deleted)
- Missing imports (if `ContractsClient.tsx` or `AssignmentsClient.tsx` weren't copied correctly)
- `usePathname` requires `'use client'` directive (already included in `AppNavbar.tsx`)

### 4b. Dev Server Visual Checks

```bash
npm run dev
```

| Route | Check | Expected Result |
|---|---|---|
| `/` | Redirect | Immediately redirects to `/timesheet` |
| `/timesheet` | App Shell | Header with logo + "ByTime" visible at top; left navbar with "My Timesheet" highlighted as active; timesheet table renders in main content area; no duplicate Avatar/Title header inside the table area |
| `/admin/contracts` | App Shell + Navigation | Same header/navbar; "Contracts & CLINs" nav link highlighted as active; contracts MRT table renders; add/edit/CLIN drawer all still work |
| `/admin/assignments` | App Shell + Navigation | Same header/navbar; "User Assignments" nav link highlighted as active; assignment form + table renders; assign/unassign still works |
| Color toggle | Header button | Clicking the sun/moon icon in the header toggles between light and dark mode across all pages |
| Navigation | Nav links | Clicking any nav link in the sidebar navigates to the correct page; the active link updates |

### 4c. Regression Checks

| Check | Expected Result |
|---|---|
| **Timesheet period navigation** | Left/right arrows in PayPeriodSelector still work; column count changes per period |
| **Timesheet hour editing** | Clicking hour cells still opens input; values save correctly |
| **Timesheet notes** | Right-clicking or long-pressing a cell still opens the note modal |
| **Contract CRUD** | Add Contract modal works; Edit Contract modal pre-fills; CLINs drawer opens and manages CLINs |
| **Assignment CRUD** | Cascading selects work; Assign button works; Deactivate button works |

### 4d. Guardrail Verification

Run a quick git diff to confirm no forbidden files were touched:

```bash
git diff --name-only
```

The output must **NOT** include:
- `src/components/timesheet/BiWeeklyTable.tsx`
- `src/components/timesheet/TimesheetContext.tsx`
- `src/components/timesheet/PayPeriodSelector.tsx`
- `src/components/timesheet/DailyNoteModal.tsx`
- `src/components/timesheet/cells/*`
- `src/data/mock-timesheet.ts`
- `src/types/timesheet.ts`
- `src/db/*`
- `src/server/actions/*`

The output **SHOULD** include:
- `src/app/page.tsx` (modified — redirect)
- `src/components/timesheet/BiWeeklyTimesheetClient.tsx` (modified — removed duplicate header)
- `src/components/shell/AppHeader.tsx` (new)
- `src/components/shell/AppNavbar.tsx` (new)
- `src/app/(app)/layout.tsx` (new)
- `src/app/(app)/timesheet/page.tsx` (new — moved)
- `src/app/(app)/admin/contracts/page.tsx` (new — moved)
- `src/app/(app)/admin/contracts/ContractsClient.tsx` (new — moved)
- `src/app/(app)/admin/assignments/page.tsx` (new — moved)
- `src/app/(app)/admin/assignments/AssignmentsClient.tsx` (new — moved)

And deletions of the old locations:
- `src/app/timesheet/page.tsx` (deleted)
- `src/app/admin/layout.tsx` (deleted)
- `src/app/admin/contracts/page.tsx` (deleted)
- `src/app/admin/contracts/ContractsClient.tsx` (deleted)
- `src/app/admin/assignments/page.tsx` (deleted)
- `src/app/admin/assignments/AssignmentsClient.tsx` (deleted)
- `src/app/page.module.css` (deleted)

### 4e. Common Errors to Watch For

| Error | Root Cause | Fix |
|---|---|---|
| `You cannot have two parallel pages that resolve to the same path` | Old route files not deleted | Delete the files listed in Step 4 |
| `usePathname only works in Client Components` | Missing `'use client'` | Verify `AppNavbar.tsx` has `'use client'` at top |
| `useMantineColorScheme must be used within MantineProvider` | AppShell rendered outside MantineProvider | Verify root `layout.tsx` wraps children with `MantineProvider` |
| `AppShell.Header is undefined` | Missing `'use client'` on layout | Verify `(app)/layout.tsx` has `'use client'` at top |
| `Module not found: @/components/shell/AppHeader` | File not created | Verify both shell components exist at the correct paths |
| Logo doesn't appear | Wrong path | Use `src="/logo.png"` (public directory asset) |
| Active link not highlighting | Wrong pathname comparison | Verify `usePathname()` returns the expected path string |
