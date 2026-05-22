# Blueprint: Polish & Hardening — Notifications, Reviewer ID, Loading States, Cleanup

## 1. Architectural Overview

### Why This Feature Matters

After eight feature blueprints, the application has a complete DCAA-compliant timekeeping workflow: authentication, WBS management, timesheet entry with append-only audit trail, save/discard with edit reason enforcement, submit/approve/reject lifecycle, user management, and admin route protection.

However, four gaps remain that collectively undermine both DCAA compliance and UX quality:

| # | Issue | Impact |
|---|---|---|
| 1 | `reviewedBy` is hardcoded to `''` in ApprovalsClient | 🔴 **DCAA audit gap** — no record of *who* approved/rejected a timesheet |
| 2 | No success/error toast notifications | 🟡 **UX gap** — users get no feedback after save/submit/approve/reject |
| 3 | No loading skeleton during period navigation | 🟡 **UX gap** — flash of empty data when switching periods |
| 4 | `src/data/mock-timesheet.ts` is dead code | 🟢 **Cleanup** — 90 lines of unreferenced mock data |

This blueprint resolves all four in a single pass, ordered by priority.

---

## 2. File Topology

```
Files to MODIFY:
├── src/app/layout.tsx                                    ← Add @mantine/notifications CSS + <Notifications /> provider
├── src/app/(app)/admin/approvals/page.tsx                 ← Pass session userId to ApprovalsClient
├── src/app/(app)/admin/approvals/ApprovalsClient.tsx      ← Accept userId prop; wire reviewedBy; add notifications
├── src/components/timesheet/TimesheetToolbar.tsx           ← Add success/error notifications for save/submit
├── src/app/(app)/admin/users/UsersClient.tsx              ← Add success notifications for user create/edit/toggle
├── src/types/timesheet.ts                                ← Add isLoadingPeriod to TimesheetState
├── src/components/timesheet/TimesheetContext.tsx           ← Set isLoadingPeriod in NAVIGATE_PERIOD / SET_PERIOD_DATA
├── src/components/timesheet/BiWeeklyTimesheetClient.tsx    ← Show Skeleton when isLoadingPeriod is true
├── src/components/timesheet/PayPeriodSelector.tsx          ← Disable nav arrows while loading

Files to DELETE:
├── src/data/mock-timesheet.ts                             ← Dead code — zero imports across src/

Files NOT TOUCHED (guardrail — DO NOT MODIFY):
├── src/db/schema.ts                                       ← ❌ DO NOT MODIFY
├── src/auth.ts                                            ← ❌ DO NOT MODIFY
├── src/middleware.ts                                      ← ❌ DO NOT MODIFY
├── src/components/timesheet/BiWeeklyTable.tsx              ← ❌ DO NOT MODIFY
├── src/components/timesheet/cells/ChargeCodeCell.tsx       ← ❌ DO NOT MODIFY
├── src/components/timesheet/cells/ColumnHeaderDate.tsx     ← ❌ DO NOT MODIFY
├── src/components/timesheet/cells/TotalHoursCell.tsx       ← ❌ DO NOT MODIFY
├── src/components/timesheet/cells/HourCell.tsx             ← ❌ DO NOT MODIFY
├── src/components/timesheet/DailyNoteModal.tsx             ← ❌ DO NOT MODIFY
├── src/components/timesheet/ReasonModal.tsx                ← ❌ DO NOT MODIFY
├── src/components/timesheet/SubmitModal.tsx                ← ❌ DO NOT MODIFY
├── src/components/shell/AppHeader.tsx                      ← ❌ DO NOT MODIFY
├── src/components/shell/AppNavbar.tsx                      ← ❌ DO NOT MODIFY
├── src/server/actions/contracts.ts                        ← ❌ DO NOT MODIFY
├── src/server/actions/clins.ts                            ← ❌ DO NOT MODIFY
├── src/server/actions/assignments.ts                      ← ❌ DO NOT MODIFY
├── src/server/actions/users.ts                            ← ❌ DO NOT MODIFY
├── src/server/actions/timesheet.ts                        ← ❌ DO NOT MODIFY
├── src/server/actions/periods.ts                          ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/contracts/*                         ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/assignments/*                       ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/users/page.tsx                      ← ❌ DO NOT MODIFY
├── src/app/(app)/timesheet/page.tsx                        ← ❌ DO NOT MODIFY
├── src/lib/*                                              ← ❌ DO NOT MODIFY
```

---

## 3. Step-by-Step Execution Plan

> **⚠️ CRITICAL GUARDRAILS FOR THE EXECUTION AGENT:**
> - **DO NOT** search, grep, or read files inside `node_modules/`, `.next/`, or `dist/`.
> - **DO NOT** read documentation files or search for library docs.
> - **DO NOT** modify any files listed in the "NOT TOUCHED" section above.
> - Use **Mantine v9** imports only (`@mantine/core`, `@mantine/hooks`, `@mantine/notifications`).
> - Use `@tabler/icons-react` for all icons.
> - Follow the step order exactly. Each step builds on the previous one.
> - **Complete each Phase fully before moving to the next Phase.**

---

## Phase A: Wire `reviewedBy` to Session User (DCAA Compliance Fix)

### Problem

`ApprovalsClient.tsx` is a client component that calls `approvePeriod()` and `rejectPeriod()` with `reviewedBy: ''` (lines 82 and 101). The `timesheetPeriods.reviewed_by` column in the database is being set to an empty string instead of the actual supervisor/admin user ID. This breaks the DCAA audit trail — there is no record of who approved or rejected a timesheet.

### Solution

Pass the current session user's ID from the server component (`page.tsx`) into the client component as a prop.

---

**A1.** Modify `src/app/(app)/admin/approvals/page.tsx` — pass `currentUserId` to the client:

The current file is:

```tsx
import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { getAllPeriods } from '@/server/actions/periods';
import { ApprovalsClient } from './ApprovalsClient';

export const dynamic = 'force-dynamic';

export default async function ApprovalsPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  const role = (session.user as any).role;
  if (role !== 'admin' && role !== 'supervisor') redirect('/timesheet');

  const periods = await getAllPeriods();
  return <ApprovalsClient initialPeriods={periods} />;
}
```

Replace with:

```tsx
import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { getAllPeriods } from '@/server/actions/periods';
import { ApprovalsClient } from './ApprovalsClient';

export const dynamic = 'force-dynamic';

export default async function ApprovalsPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  const role = (session.user as any).role;
  if (role !== 'admin' && role !== 'supervisor') redirect('/timesheet');

  const periods = await getAllPeriods();
  return <ApprovalsClient initialPeriods={periods} currentUserId={session.user.id!} />;
}
```

**Only change:** Added `currentUserId={session.user.id!}` prop.

---

**A2.** Modify `src/app/(app)/admin/approvals/ApprovalsClient.tsx` — accept and use the `currentUserId` prop:

**A2a.** Update the `Props` type to accept `currentUserId`:

Change:
```typescript
type Props = {
  initialPeriods: Period[];
};
```

To:
```typescript
type Props = {
  initialPeriods: Period[];
  currentUserId: string;
};
```

**A2b.** Update the component signature to destructure `currentUserId`:

Change:
```typescript
export function ApprovalsClient({ initialPeriods }: Props) {
```

To:
```typescript
export function ApprovalsClient({ initialPeriods, currentUserId }: Props) {
```

**A2c.** In `handleApprove()`, replace the hardcoded empty string:

Change:
```typescript
await approvePeriod({
  periodId: selectedPeriod.id,
  reviewedBy: '', // Will use session in production
  comment: approveComment.trim() || undefined,
});
```

To:
```typescript
await approvePeriod({
  periodId: selectedPeriod.id,
  reviewedBy: currentUserId,
  comment: approveComment.trim() || undefined,
});
```

**A2d.** In `handleReject()`, replace the hardcoded empty string:

Change:
```typescript
await rejectPeriod({
  periodId: selectedPeriod.id,
  reviewedBy: '', // Will use session in production
  comment: rejectComment.trim(),
});
```

To:
```typescript
await rejectPeriod({
  periodId: selectedPeriod.id,
  reviewedBy: currentUserId,
  comment: rejectComment.trim(),
});
```

### Phase A Verification

```bash
npm run build
```

Must pass with zero errors. Then:

| Check | Expected |
|---|---|
| Login as admin/supervisor, approve a timesheet | `reviewedBy` in DB is the admin's UUID (not empty string) |
| Reject a timesheet | `reviewedBy` in DB is the supervisor's UUID |

Verify via:
```bash
psql postgresql://bytime:bytime_dev@localhost:5432/bytime -c "
SELECT tp.id, u.full_name as employee, tp.status, tp.reviewed_by, r.full_name as reviewer
FROM timesheet_periods tp
JOIN users u ON tp.user_id = u.id
LEFT JOIN users r ON tp.reviewed_by = r.id
ORDER BY tp.updated_at DESC LIMIT 5;
"
```

**⚠️ Do NOT proceed to Phase B until Phase A builds and verifies correctly.**

---

## Phase B: Add Mantine Notifications (Success Toasts)

### Problem

Save, submit, approve, reject, and user management actions have no visible feedback beyond button loading states. Users cannot tell if an action succeeded or failed without checking the data manually.

### Solution

Install `@mantine/notifications`, add the provider to the root layout, then add `notifications.show()` calls after successful and failed actions.

---

**B1.** Install the `@mantine/notifications` package:

```bash
npm install @mantine/notifications
```

---

**B2.** Modify `src/app/layout.tsx` — add the Notifications provider and CSS import.

The current file is:

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

Replace with:

```tsx
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "./globals.css";
import { MantineProvider, createTheme } from "@mantine/core";
import { Notifications } from "@mantine/notifications";

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
        <MantineProvider defaultColorScheme="auto" theme={theme}>
          <Notifications position="top-right" autoClose={4000} />
          {children}
        </MantineProvider>
      </body>
    </html>
  );
}
```

**Changes:**
- Added `import "@mantine/notifications/styles.css";` after the core styles import
- Added `import { Notifications } from "@mantine/notifications";`
- Added `<Notifications position="top-right" autoClose={4000} />` inside `MantineProvider`, before `{children}`

---

**B3.** Modify `src/components/timesheet/TimesheetToolbar.tsx` — add success/error notifications for save and submit:

Replace the entire file with:

```tsx
'use client';

import { Button, Group, Badge, Text, Alert } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconDeviceFloppy, IconArrowBack, IconSend, IconAlertCircle, IconCheck, IconX } from '@tabler/icons-react';
import { useTimesheet } from '@/components/timesheet/TimesheetContext';
import { useState } from 'react';
import { ReasonModal } from '@/components/timesheet/ReasonModal';
import { SubmitModal } from '@/components/timesheet/SubmitModal';
import dayjs from 'dayjs';
import { getNumDaysInPeriod } from '@/lib/date-utils';

const STATUS_BADGES: Record<string, { color: string; label: string }> = {
  draft: { color: 'yellow', label: 'Draft' },
  submitted: { color: 'blue', label: 'Submitted — Pending Review' },
  approved: { color: 'green', label: 'Approved' },
  rejected: { color: 'red', label: 'Rejected — Corrections Needed' },
};

export function TimesheetToolbar() {
  const { dirtyCells, hasEdits, saveAll, discardChanges, submitTimesheet, state } = useTimesheet();
  const [reasonModalOpen, setReasonModalOpen] = useState(false);
  const [submitModalOpen, setSubmitModalOpen] = useState(false);

  const dirtyCount = dirtyCells.length;
  const { periodStatus, periodStart } = state;
  const isEditable = periodStatus === 'draft' || periodStatus === 'rejected';
  const canSubmit = isEditable && dirtyCount === 0 && state.entries.some((e) => e.hours.some((h) => h > 0));

  // Build period label for the submit modal
  const start = dayjs(periodStart);
  const numDays = getNumDaysInPeriod(periodStart);
  const end = start.add(numDays - 1, 'day');
  const periodLabel = `${start.format('MMM D')} – ${end.format('MMM D, YYYY')}`;

  const statusBadge = STATUS_BADGES[periodStatus] ?? STATUS_BADGES.draft;

  async function handleSave() {
    if (dirtyCount === 0) return;

    if (hasEdits) {
      setReasonModalOpen(true);
      return;
    }

    try {
      await saveAll();
      notifications.show({
        title: 'Timesheet Saved',
        message: `${dirtyCount} ${dirtyCount === 1 ? 'entry' : 'entries'} saved successfully.`,
        color: 'green',
        icon: <IconCheck size={16} />,
      });
    } catch {
      notifications.show({
        title: 'Save Failed',
        message: 'Failed to save timesheet. Please try again.',
        color: 'red',
        icon: <IconX size={16} />,
      });
    }
  }

  async function handleReasonConfirm(reasonCode: string, comment: string) {
    try {
      await saveAll(reasonCode, comment);
      setReasonModalOpen(false);
      notifications.show({
        title: 'Timesheet Saved',
        message: `${dirtyCount} ${dirtyCount === 1 ? 'entry' : 'entries'} saved with reason: ${reasonCode}.`,
        color: 'green',
        icon: <IconCheck size={16} />,
      });
    } catch {
      notifications.show({
        title: 'Save Failed',
        message: 'Failed to save timesheet. Please try again.',
        color: 'red',
        icon: <IconX size={16} />,
      });
    }
  }

  function handleDiscard() {
    discardChanges();
    notifications.show({
      title: 'Changes Discarded',
      message: 'All unsaved changes have been reverted.',
      color: 'gray',
    });
  }

  async function handleSubmitConfirm(comment?: string) {
    try {
      await submitTimesheet(comment);
      setSubmitModalOpen(false);
      notifications.show({
        title: 'Timesheet Submitted',
        message: `Your timesheet for ${periodLabel} has been submitted for supervisor review.`,
        color: 'blue',
        icon: <IconCheck size={16} />,
      });
    } catch {
      notifications.show({
        title: 'Submit Failed',
        message: 'Failed to submit timesheet. Please try again.',
        color: 'red',
        icon: <IconX size={16} />,
      });
    }
  }

  return (
    <>
      {/* Rejection notice */}
      {periodStatus === 'rejected' && (
        <Alert icon={<IconAlertCircle size={16} />} color="red" variant="light" mb="sm">
          <Text size="sm" fw={600}>
            This timesheet was returned for corrections. Please review the supervisor&apos;s comments, make necessary changes, and re-submit.
          </Text>
        </Alert>
      )}

      <Group justify="space-between" mb="sm" gap="sm">
        {/* Left: Status badge */}
        <Badge variant="light" color={statusBadge.color} size="lg">
          {statusBadge.label}
        </Badge>

        {/* Right: Action buttons */}
        <Group gap="sm">
          {dirtyCount > 0 && (
            <Badge variant="light" color="yellow" size="lg">
              {dirtyCount} unsaved {dirtyCount === 1 ? 'change' : 'changes'}
            </Badge>
          )}

          {isEditable && (
            <>
              <Button
                variant="default"
                leftSection={<IconArrowBack size={16} />}
                onClick={handleDiscard}
                disabled={dirtyCount === 0}
              >
                Discard Changes
              </Button>
              <Button
                leftSection={<IconDeviceFloppy size={16} />}
                onClick={handleSave}
                disabled={dirtyCount === 0}
                loading={state.isSaving}
              >
                Save
              </Button>
              <Button
                color="green"
                leftSection={<IconSend size={16} />}
                onClick={() => setSubmitModalOpen(true)}
                disabled={!canSubmit}
              >
                Submit
              </Button>
            </>
          )}
        </Group>
      </Group>

      <ReasonModal
        opened={reasonModalOpen}
        onClose={() => setReasonModalOpen(false)}
        onConfirm={handleReasonConfirm}
        editedCells={dirtyCells.filter((c) => c.isEdit)}
        chargeCodes={state.chargeCodes}
        periodStart={state.periodStart}
        isSaving={state.isSaving}
      />

      <SubmitModal
        opened={submitModalOpen}
        onClose={() => setSubmitModalOpen(false)}
        onConfirm={handleSubmitConfirm}
        isSaving={state.isSaving}
        periodLabel={periodLabel}
      />
    </>
  );
}
```

**Key changes from the original:**
- Added `import { notifications } from '@mantine/notifications';`
- Added `import { IconCheck, IconX } from '@tabler/icons-react';` (new icons)
- Replaced `setSaveError(...)` pattern with `notifications.show()` calls
- Removed `saveError` state entirely — errors now show as red notification toasts
- Added success notifications after save, submit, discard
- Simplified rejection notice conditional (removed redundant `state.periodStatus` check)

---

**B4.** Modify `src/app/(app)/admin/approvals/ApprovalsClient.tsx` — add notifications for approve/reject actions.

After the Phase A changes, make these additional modifications:

**B4a.** Add the notifications import at the top of the file (after existing imports):

```typescript
import { notifications } from '@mantine/notifications';
import { IconCheck as IconCheckNotif, IconX as IconXNotif } from '@tabler/icons-react';
```

> Note: `IconCheck` and `IconX` are already imported in this file for the approve/reject buttons. To avoid name collisions, either alias them or reuse the existing imports. The simplest approach: reuse the existing `IconCheck` and `IconX` imports (they're already imported). Just add:

```typescript
import { notifications } from '@mantine/notifications';
```

**B4b.** In `handleApprove()`, after `setDrawerOpen(false)`, add a success notification:

Change the try block in `handleApprove` to:

```typescript
try {
  setActionError(null);
  await approvePeriod({
    periodId: selectedPeriod.id,
    reviewedBy: currentUserId,
    comment: approveComment.trim() || undefined,
  });
  const refreshed = await getAllPeriods();
  setPeriods(refreshed);
  setDrawerOpen(false);
  notifications.show({
    title: 'Timesheet Approved',
    message: `${selectedPeriod.userName}'s timesheet has been approved.`,
    color: 'green',
    icon: <IconCheck size={16} />,
  });
} catch (error) {
  setActionError(String(error));
  notifications.show({
    title: 'Approval Failed',
    message: 'Failed to approve timesheet. Please try again.',
    color: 'red',
    icon: <IconX size={16} />,
  });
}
```

**B4c.** In `handleReject()`, after `setDrawerOpen(false)`, add a success notification:

Change the try block in `handleReject` to:

```typescript
try {
  setActionError(null);
  await rejectPeriod({
    periodId: selectedPeriod.id,
    reviewedBy: currentUserId,
    comment: rejectComment.trim(),
  });
  const refreshed = await getAllPeriods();
  setPeriods(refreshed);
  setDrawerOpen(false);
  notifications.show({
    title: 'Timesheet Rejected',
    message: `${selectedPeriod.userName}'s timesheet has been returned for corrections.`,
    color: 'orange',
    icon: <IconX size={16} />,
  });
} catch (error) {
  setActionError(String(error));
  notifications.show({
    title: 'Rejection Failed',
    message: 'Failed to reject timesheet. Please try again.',
    color: 'red',
    icon: <IconX size={16} />,
  });
}
```

---

**B5.** Modify `src/app/(app)/admin/users/UsersClient.tsx` — add notifications for user management actions.

**B5a.** Add the notifications import:

```typescript
import { notifications } from '@mantine/notifications';
```

**B5b.** In `handleSubmit()`, after `setModalOpen(false)`, add a success notification. Update the try block to:

```typescript
try {
  setFormError(null);
  if (editingUser) {
    // Update existing user
    const updateData: { fullName?: string; email?: string; role?: 'admin' | 'supervisor' | 'employee' } = {};
    if (form.fullName !== editingUser.fullName) updateData.fullName = form.fullName;
    if (form.email !== editingUser.email) updateData.email = form.email;
    if (form.role !== editingUser.role) updateData.role = form.role as 'admin' | 'supervisor' | 'employee';

    if (Object.keys(updateData).length > 0) {
      await updateUser(editingUser.id, updateData);
    }
    notifications.show({
      title: 'User Updated',
      message: `${form.fullName} has been updated successfully.`,
      color: 'green',
    });
  } else {
    // Create new user
    if (!form.email || !form.fullName || !form.password) {
      setFormError('All fields are required for new users.');
      return;
    }
    if (form.password.length < 8) {
      setFormError('Password must be at least 8 characters.');
      return;
    }
    await createUserWithPassword({
      email: form.email,
      fullName: form.fullName,
      role: form.role as 'admin' | 'supervisor' | 'employee',
      password: form.password,
    });
    notifications.show({
      title: 'User Created',
      message: `${form.fullName} has been created successfully.`,
      color: 'green',
    });
  }

  // Refresh user list
  const refreshed = await getUsers();
  setUsers(refreshed as User[]);
  setModalOpen(false);
} catch (error) {
  setFormError(String(error));
  notifications.show({
    title: 'Action Failed',
    message: 'Something went wrong. Please try again.',
    color: 'red',
  });
}
```

**B5c.** In `handleToggleActive()`, add a notification after the toggle:

Change:
```typescript
function handleToggleActive(user: User) {
  startTransition(async () => {
    await updateUser(user.id, { isActive: !user.isActive });
    const refreshed = await getUsers();
    setUsers(refreshed as User[]);
  });
}
```

To:
```typescript
function handleToggleActive(user: User) {
  startTransition(async () => {
    const newActive = !user.isActive;
    await updateUser(user.id, { isActive: newActive });
    const refreshed = await getUsers();
    setUsers(refreshed as User[]);
    notifications.show({
      title: newActive ? 'User Activated' : 'User Deactivated',
      message: `${user.fullName} has been ${newActive ? 'activated' : 'deactivated'}.`,
      color: newActive ? 'green' : 'yellow',
    });
  });
}
```

### Phase B Verification

```bash
npm run build
```

Must pass with zero errors. Then:

| Check | Expected |
|---|---|
| **Save timesheet entries** | Green toast: "Timesheet Saved" with entry count |
| **Save with edit reason** | Green toast includes reason code |
| **Save failure** | Red toast: "Save Failed" |
| **Discard changes** | Gray toast: "Changes Discarded" |
| **Submit timesheet** | Blue toast: "Timesheet Submitted" with period label |
| **Approve timesheet** | Green toast: "Timesheet Approved" with employee name |
| **Reject timesheet** | Orange toast: "Timesheet Rejected" with employee name |
| **Create user** | Green toast: "User Created" with user name |
| **Edit user** | Green toast: "User Updated" with user name |
| **Toggle user active** | Green/yellow toast: "User Activated/Deactivated" |
| **All toasts auto-dismiss** | Toasts disappear after 4 seconds |
| **Toast position** | Top-right corner of the viewport |

**⚠️ Do NOT proceed to Phase C until Phase B builds and verifies correctly.**

---

## Phase C: Loading Skeletons for Period Navigation

### Problem

When the user clicks the left/right arrow in `PayPeriodSelector` to navigate to a different pay period, the reducer immediately clears entries to empty arrays (`NAVIGATE_PERIOD` case), then asynchronously fetches new data. During the fetch (which can take 200ms–2s), the table shows all zeroes / dashes, which is jarring.

### Solution

Add an `isLoadingPeriod` flag to the state. Set it `true` in `NAVIGATE_PERIOD`, `false` in `SET_PERIOD_DATA`. Show a `Skeleton` overlay in `BiWeeklyTimesheetClient` when loading. Disable navigation arrows while loading.

---

**C1.** Modify `src/types/timesheet.ts` — add `isLoadingPeriod` to `TimesheetState`:

Add this field to the `TimesheetState` interface, after `isSaving`:

```typescript
isLoadingPeriod: boolean; // true while fetching data for a new period
```

---

**C2.** Modify `src/components/timesheet/TimesheetContext.tsx` — set the loading flag in the reducer:

**C2a.** In the `initialState` inside `TimesheetProvider`, add:

```typescript
isLoadingPeriod: false,
```

**C2b.** In the `NAVIGATE_PERIOD` case of the reducer, add `isLoadingPeriod: true`:

Change the return object in the `NAVIGATE_PERIOD` case to include:

```typescript
isLoadingPeriod: true,
```

So the full `NAVIGATE_PERIOD` case becomes:

```typescript
case 'NAVIGATE_PERIOD': {
  const newPeriodStart = navigatePeriod(state.periodStart, action.direction);
  const emptyEntries = state.chargeCodes.map((cc) => ({
    chargeCodeId: cc.id,
    hours: [] as number[],
  }));
  return {
    ...state,
    periodStart: newPeriodStart,
    entries: emptyEntries,
    savedEntries: emptyEntries,
    savedCellRevisions: {},
    notes: {},
    periodStatus: 'draft',
    isLoadingPeriod: true,
  };
}
```

**C2c.** In the `SET_PERIOD_DATA` case, set `isLoadingPeriod: false`:

Change the return object in the `SET_PERIOD_DATA` case to include:

```typescript
isLoadingPeriod: false,
```

So the full `SET_PERIOD_DATA` case becomes:

```typescript
case 'SET_PERIOD_DATA': {
  return {
    ...state,
    periodStart: action.periodStart,
    entries: action.entries,
    savedEntries: action.entries.map((e) => ({ ...e, hours: [...e.hours] })),
    savedCellRevisions: action.revisions,
    periodStatus: action.periodStatus ?? state.periodStatus,
    isLoadingPeriod: false,
  };
}
```

---

**C3.** Modify `src/components/timesheet/BiWeeklyTimesheetClient.tsx` — show Skeleton when loading:

Replace the entire file with:

```tsx
'use client';

import { Container, Paper, Skeleton, Stack } from '@mantine/core';
import { TimesheetProvider, useTimesheet } from '@/components/timesheet/TimesheetContext';
import { BiWeeklyTable } from '@/components/timesheet/BiWeeklyTable';
import { DailyNoteModal } from '@/components/timesheet/DailyNoteModal';
import { PayPeriodSelector } from '@/components/timesheet/PayPeriodSelector';
import { TimesheetToolbar } from '@/components/timesheet/TimesheetToolbar';
import type { TimesheetPageData } from '@/types/timesheet';

function TimesheetContent() {
  const { state } = useTimesheet();

  return (
    <Container fluid px="md" py="xl">
      <PayPeriodSelector />
      <TimesheetToolbar />
      <Paper shadow="xs" p="md" radius="md" style={{ overflowX: 'auto' }}>
        {state.isLoadingPeriod ? (
          <Stack gap="sm">
            <Skeleton height={40} radius="sm" />
            <Skeleton height={36} radius="sm" />
            <Skeleton height={36} radius="sm" />
            <Skeleton height={36} radius="sm" />
            <Skeleton height={36} radius="sm" />
            <Skeleton height={36} radius="sm" />
            <Skeleton height={40} radius="sm" />
          </Stack>
        ) : (
          <BiWeeklyTable />
        )}
      </Paper>
      <DailyNoteModal />
    </Container>
  );
}

type Props = {
  initialData: TimesheetPageData;
};

export function BiWeeklyTimesheetClient({ initialData }: Props) {
  return (
    <TimesheetProvider initialData={initialData}>
      <TimesheetContent />
    </TimesheetProvider>
  );
}
```

**Key changes:**
- Added `Skeleton, Stack` imports from Mantine
- Added `useTimesheet` import to access `state.isLoadingPeriod`
- When `isLoadingPeriod` is true, renders 7 Skeleton bars (header + ~5 rows + footer) instead of `BiWeeklyTable`
- When loading completes, renders the table normally

---

**C4.** Modify `src/components/timesheet/PayPeriodSelector.tsx` — disable navigation arrows while loading:

Read the current file to determine the exact structure, then make these changes:

**C4a.** The component currently destructures `useTimesheet()` as `{ state, dispatch }` or `{ state, loadPeriod }`. Ensure `state` is available.

**C4b.** Add `disabled={state.isLoadingPeriod}` to both `ActionIcon` components:

For the **previous** button:
```tsx
<ActionIcon
  variant="subtle"
  size="lg"
  onClick={() => loadPeriod('prev')}
  aria-label="Previous pay period"
  disabled={state.isLoadingPeriod}
>
  <IconChevronLeft size={20} />
</ActionIcon>
```

For the **next** button:
```tsx
<ActionIcon
  variant="subtle"
  size="lg"
  onClick={() => loadPeriod('next')}
  aria-label="Next pay period"
  disabled={state.isLoadingPeriod}
>
  <IconChevronRight size={20} />
</ActionIcon>
```

### Phase C Verification

```bash
npm run build
```

Must pass with zero errors. Then:

| Check | Expected |
|---|---|
| **Navigate to next period** | Skeleton bars appear instantly; table renders after data loads |
| **Navigate to previous period** | Same skeleton behavior |
| **Arrows disabled during load** | Cannot double-click to skip periods |
| **Initial page load** | No skeleton (data comes from server props; `isLoadingPeriod` starts as `false`) |
| **Skeleton matches table layout** | 7 rows of skeleton (approximate header + 5 charge code rows + footer) |
| **Fast navigation** | Skeleton appears briefly, then table renders |

**⚠️ Do NOT proceed to Phase D until Phase C builds and verifies correctly.**

---

## Phase D: Delete Dead Mock Data

### Problem

`src/data/mock-timesheet.ts` is 90 lines of dead code. A search for `mock-timesheet` across `src/` returns zero results — no file imports from it. It was fully replaced by database integration in `feature-plan-timesheet-db.md`.

### Solution

Delete the file.

---

**D1.** Delete `src/data/mock-timesheet.ts`:

```bash
rm src/data/mock-timesheet.ts
```

**D2.** If `src/data/` is now an empty directory, delete it:

```bash
rmdir src/data/ 2>/dev/null || true
```

### Phase D Verification

```bash
npm run build
```

Must pass with zero errors. If any file still imports from `@/data/mock-timesheet`, the build will fail — fix the import (this should not happen based on the search results showing zero matches).

---

## 4. Final Verification

### 4a. Build Check

```bash
npm run build
```

Must complete with **zero errors**.

### 4b. Guardrail Verification

```bash
git diff --name-only
```

**SHOULD** include:
- `src/app/layout.tsx` (Phase B — notifications provider)
- `src/app/(app)/admin/approvals/page.tsx` (Phase A — userId prop)
- `src/app/(app)/admin/approvals/ApprovalsClient.tsx` (Phase A+B — reviewedBy + notifications)
- `src/components/timesheet/TimesheetToolbar.tsx` (Phase B — notifications)
- `src/app/(app)/admin/users/UsersClient.tsx` (Phase B — notifications)
- `src/types/timesheet.ts` (Phase C — isLoadingPeriod)
- `src/components/timesheet/TimesheetContext.tsx` (Phase C — loading flag)
- `src/components/timesheet/BiWeeklyTimesheetClient.tsx` (Phase C — skeleton)
- `src/components/timesheet/PayPeriodSelector.tsx` (Phase C — disabled arrows)
- `package.json` (Phase B — @mantine/notifications)

**Deletions:**
- `src/data/mock-timesheet.ts` (Phase D)

Must **NOT** include:
- `src/db/schema.ts`
- `src/auth.ts`
- `src/middleware.ts`
- `src/components/timesheet/BiWeeklyTable.tsx`
- `src/components/timesheet/cells/*`
- `src/components/timesheet/DailyNoteModal.tsx`
- `src/components/timesheet/ReasonModal.tsx`
- `src/components/timesheet/SubmitModal.tsx`
- `src/components/shell/*`
- `src/server/actions/*`
- `src/app/(app)/admin/contracts/*`
- `src/app/(app)/admin/assignments/*`
- `src/app/(app)/admin/users/page.tsx`
- `src/app/(app)/timesheet/page.tsx`

### 4c. End-to-End Smoke Test

| Flow | Steps | Expected |
|---|---|---|
| **Employee save** | Login as employee → edit cells → Save | Green toast "Timesheet Saved" |
| **Employee submit** | Save → Submit → Certify | Blue toast "Timesheet Submitted" |
| **Supervisor approve** | Login as admin → Approvals → Review → Approve | Green toast; `reviewed_by` populated in DB |
| **Supervisor reject** | Review → type comment → Reject | Orange toast; `reviewed_by` populated in DB |
| **Period navigation** | Click right arrow | Skeleton appears → table loads |
| **User management** | Create user → edit user → toggle active | Green/yellow toasts for each action |
| **Build clean** | `npm run build` | Zero errors, zero warnings related to our changes |

### 4d. Common Errors to Watch For

| Error | Root Cause | Fix |
|---|---|---|
| `notifications is not a function` | Missing `@mantine/notifications` install | Run `npm install @mantine/notifications` |
| `Cannot find module '@mantine/notifications/styles.css'` | Package not installed | Run `npm install @mantine/notifications` |
| `Property 'isLoadingPeriod' does not exist on type 'TimesheetState'` | Type not updated | Add `isLoadingPeriod: boolean` to `TimesheetState` in `src/types/timesheet.ts` |
| `Notifications must be rendered within MantineProvider` | `<Notifications />` outside provider | Verify it's inside `<MantineProvider>` in `layout.tsx` |
| `Property 'currentUserId' is missing` | Prop not passed from page | Verify `page.tsx` passes `currentUserId={session.user.id!}` |
| `Module '@/data/mock-timesheet' not found` | Stale import after deletion | Should not happen (search confirmed zero imports) — if it does, find and remove the import |
| Skeleton height doesn't match table | Aesthetic issue only | Adjust Skeleton `height` values to approximate the actual table row heights |
