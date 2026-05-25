# Blueprint: Employee Dashboard — Personal Timesheet Status & Period Overview

## 1. Architectural Overview

### The Problem

Currently, employees land directly on the timesheet grid (`/timesheet`). There is no overview showing:
- Current period status (draft/submitted/approved/rejected)
- Hours entered this period vs. expected
- Upcoming submission deadline
- Recent approval history across periods
- Quick navigation to past periods

Employees must mentally track their submission status and deadlines with no visual cues.

### The Solution

Add an **Employee Dashboard** as the default landing page at `/timesheet` (or as a new `/dashboard` route for employees). The dashboard provides at-a-glance status with easy navigation to the timesheet grid.

**Design Decision:** Rather than replacing `/timesheet`, create a new route at `/` (the root redirect currently goes straight to `/timesheet`). Change the redirect to go to a dashboard page that includes a prominent "Enter Time" button linking to `/timesheet`. This preserves the existing timesheet UX while adding context.

**Alternative (simpler):** Add the dashboard content as a collapsible section ABOVE the existing timesheet grid on the `/timesheet` page. This avoids creating a new route and keeps everything on one page.

**Chosen approach:** Add dashboard widgets above the timesheet grid on the existing `/timesheet` page. This is simpler, doesn't require route changes, and gives employees immediate context before they start entering time.

---

## 2. File Topology

```
Files to CREATE:
├── src/components/timesheet/TimesheetDashboard.tsx   ← Dashboard widget component
├── src/server/actions/employee-dashboard.ts          ← Server Actions: dashboard data queries

Files to MODIFY:
├── src/components/timesheet/BiWeeklyTimesheetClient.tsx ← Add dashboard above grid
├── src/app/(app)/timesheet/page.tsx                   ← Fetch dashboard data, pass to client
├── src/types/timesheet.ts                             ← Add dashboard data to TimesheetPageData

Files NOT TOUCHED (guardrail — DO NOT MODIFY):
├── src/db/schema.ts                                   ← ❌ DO NOT MODIFY
├── src/auth.ts                                        ← ❌ DO NOT MODIFY
├── src/middleware.ts                                  ← ❌ DO NOT MODIFY
├── src/components/timesheet/BiWeeklyTable.tsx          ← ❌ DO NOT MODIFY
├── src/components/timesheet/TimesheetContext.tsx       ← ❌ DO NOT MODIFY
├── src/components/timesheet/TimesheetToolbar.tsx       ← ❌ DO NOT MODIFY
├── src/components/timesheet/cells/*                    ← ❌ DO NOT MODIFY
├── src/components/timesheet/PayPeriodSelector.tsx      ← ❌ DO NOT MODIFY
├── src/components/timesheet/SubmitModal.tsx            ← ❌ DO NOT MODIFY
├── src/components/timesheet/ReasonModal.tsx            ← ❌ DO NOT MODIFY
├── src/components/timesheet/DailyNoteModal.tsx         ← ❌ DO NOT MODIFY
├── src/components/shell/*                             ← ❌ DO NOT MODIFY
├── src/server/actions/timesheet.ts                    ← ❌ DO NOT MODIFY
├── src/server/actions/periods.ts                      ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/**                              ← ❌ DO NOT MODIFY
├── src/lib/**                                         ← ❌ DO NOT MODIFY (except date-utils if needed)
```

---

## 3. Step-by-Step Execution Plan

> **⚠️ CRITICAL GUARDRAILS:**
> - **DO NOT** search inside `node_modules/`, `.next/`, or `dist/`.
> - **DO NOT** modify files in the "NOT TOUCHED" list.
> - Use **Mantine v9** components only.
> - The dashboard must NOT break the existing timesheet grid functionality.
> - **After each phase, run `npm run build` to verify zero errors.**

---

### Phase A: Dashboard Data Server Action (A1)

#### A1. Create `src/server/actions/employee-dashboard.ts`

```typescript
'use server';

import { db } from '@/db';
import { timesheetEntries, timesheetPeriods, users } from '@/db/schema';
import { eq, and, gte, lt, desc, sql } from 'drizzle-orm';
import dayjs from 'dayjs';
import { getNumDaysInPeriod, getCurrentPeriodStart } from '@/lib/date-utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmployeeDashboardData {
  currentPeriod: {
    periodStart: Date;
    periodEnd: Date;
    periodLabel: string;
    status: string;
    submittedAt: Date | null;
    reviewedAt: Date | null;
    reviewComment: string | null;
    totalHoursEntered: number;
    expectedWorkdays: number;
    daysWithEntries: number;
    daysRemaining: number;
    submissionDeadline: string;
    canSubmitToday: boolean;
  };
  recentPeriods: Array<{
    periodStart: Date;
    periodLabel: string;
    status: string;
    totalHours: number;
    submittedAt: Date | null;
    reviewedAt: Date | null;
  }>;
}

// ---------------------------------------------------------------------------
// Dashboard Query
// ---------------------------------------------------------------------------

export async function getEmployeeDashboardData(userId: string): Promise<EmployeeDashboardData> {
  const periodStart = getCurrentPeriodStart();
  const numDays = getNumDaysInPeriod(periodStart);
  const periodEnd = dayjs(periodStart).add(numDays - 1, 'day');
  const periodLabel = `${dayjs(periodStart).format('MMM D')} – ${periodEnd.format('MMM D, YYYY')}`;

  // Get current period status
  const periodRows = await db
    .select()
    .from(timesheetPeriods)
    .where(
      and(
        eq(timesheetPeriods.userId, userId),
        eq(timesheetPeriods.periodStart, periodStart),
      )
    );

  const period = periodRows[0];

  // Get total hours entered in current period
  const hoursResult = await db
    .select({
      totalHours: sql<number>`COALESCE(SUM(CAST(${timesheetEntries.hours} AS NUMERIC)), 0)`,
      distinctDays: sql<number>`COUNT(DISTINCT ${timesheetEntries.entryDate})`,
    })
    .from(timesheetEntries)
    .where(
      and(
        eq(timesheetEntries.userId, userId),
        gte(timesheetEntries.entryDate, periodStart),
        lt(timesheetEntries.entryDate, dayjs(periodStart).add(numDays, 'day').toDate()),
        eq(
          timesheetEntries.revisionNumber,
          sql`(
            SELECT MAX(te2.revision_number)
            FROM timesheet_entries te2
            WHERE te2.user_id = ${timesheetEntries.userId}
              AND COALESCE(te2.clin_id, te2.indirect_code_id) = COALESCE(${timesheetEntries.clinId}, ${timesheetEntries.indirectCodeId})
              AND te2.entry_date = ${timesheetEntries.entryDate}
          )`
        ),
      )
    );

  // Count expected workdays (Mon-Fri) up to today
  let expectedWorkdays = 0;
  let daysRemaining = 0;
  const today = dayjs();
  for (let i = 0; i < numDays; i++) {
    const date = dayjs(periodStart).add(i, 'day');
    const dow = date.day();
    const isWeekday = dow >= 1 && dow <= 5;
    if (isWeekday) {
      if (date.isAfter(today, 'day')) {
        daysRemaining++;
      } else {
        expectedWorkdays++;
      }
    }
  }

  const canSubmitToday = dayjs().isSameOrAfter(periodEnd, 'day');

  // Get recent periods (last 5)
  const recentRows = await db
    .select({
      periodStart: timesheetPeriods.periodStart,
      status: timesheetPeriods.status,
      submittedAt: timesheetPeriods.submittedAt,
      reviewedAt: timesheetPeriods.reviewedAt,
    })
    .from(timesheetPeriods)
    .where(eq(timesheetPeriods.userId, userId))
    .orderBy(desc(timesheetPeriods.periodStart))
    .limit(5);

  // For each recent period, get total hours
  const recentPeriods = await Promise.all(
    recentRows.map(async (rp) => {
      const rpNumDays = getNumDaysInPeriod(rp.periodStart);
      const rpEnd = dayjs(rp.periodStart).add(rpNumDays - 1, 'day');

      const rpHours = await db
        .select({
          total: sql<number>`COALESCE(SUM(CAST(${timesheetEntries.hours} AS NUMERIC)), 0)`,
        })
        .from(timesheetEntries)
        .where(
          and(
            eq(timesheetEntries.userId, userId),
            gte(timesheetEntries.entryDate, rp.periodStart),
            lt(timesheetEntries.entryDate, dayjs(rp.periodStart).add(rpNumDays, 'day').toDate()),
            eq(
              timesheetEntries.revisionNumber,
              sql`(
                SELECT MAX(te2.revision_number)
                FROM timesheet_entries te2
                WHERE te2.user_id = ${timesheetEntries.userId}
                  AND COALESCE(te2.clin_id, te2.indirect_code_id) = COALESCE(${timesheetEntries.clinId}, ${timesheetEntries.indirectCodeId})
                  AND te2.entry_date = ${timesheetEntries.entryDate}
              )`
            ),
          )
        );

      return {
        periodStart: rp.periodStart,
        periodLabel: `${dayjs(rp.periodStart).format('MMM D')} – ${rpEnd.format('MMM D, YYYY')}`,
        status: rp.status,
        totalHours: Math.round(Number(rpHours[0]?.total ?? 0) * 100) / 100,
        submittedAt: rp.submittedAt,
        reviewedAt: rp.reviewedAt,
      };
    })
  );

  return {
    currentPeriod: {
      periodStart,
      periodEnd: periodEnd.toDate(),
      periodLabel,
      status: period?.status ?? 'draft',
      submittedAt: period?.submittedAt ?? null,
      reviewedAt: period?.reviewedAt ?? null,
      reviewComment: period?.reviewComment ?? null,
      totalHoursEntered: Math.round(Number(hoursResult[0]?.totalHours ?? 0) * 100) / 100,
      expectedWorkdays,
      daysWithEntries: Number(hoursResult[0]?.distinctDays ?? 0),
      daysRemaining,
      submissionDeadline: periodEnd.format('MMM D, YYYY'),
      canSubmitToday,
    },
    recentPeriods,
  };
}
```

---

### Phase B: Dashboard Widget Component (B1)

#### B1. Create `src/components/timesheet/TimesheetDashboard.tsx`

```tsx
'use client';

import {
  SimpleGrid,
  Paper,
  Group,
  Text,
  Badge,
  Progress,
  ThemeIcon,
  Stack,
  Table,
  Divider,
  Alert,
} from '@mantine/core';
import {
  IconClock,
  IconCalendar,
  IconCheck,
  IconSend,
  IconAlertCircle,
  IconHistory,
} from '@tabler/icons-react';
import dayjs from 'dayjs';
import type { EmployeeDashboardData } from '@/server/actions/employee-dashboard';

type Props = {
  data: EmployeeDashboardData;
};

const STATUS_COLORS: Record<string, string> = {
  draft: 'yellow',
  submitted: 'blue',
  approved: 'green',
  rejected: 'red',
};

const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  approved: 'Approved',
  rejected: 'Rejected',
};

export function TimesheetDashboard({ data }: Props) {
  const { currentPeriod, recentPeriods } = data;

  // Calculate completion percentage
  const completionPct = currentPeriod.expectedWorkdays > 0
    ? Math.min(100, Math.round((currentPeriod.daysWithEntries / currentPeriod.expectedWorkdays) * 100))
    : 0;

  const completionColor = completionPct >= 80 ? 'green' : completionPct >= 50 ? 'yellow' : 'red';

  return (
    <Stack gap="md" mb="lg">
      {/* Rejection notice */}
      {currentPeriod.status === 'rejected' && currentPeriod.reviewComment && (
        <Alert icon={<IconAlertCircle size={16} />} color="red" variant="light">
          <Text size="sm" fw={600}>Timesheet returned for corrections:</Text>
          <Text size="sm" mt={4}>"{currentPeriod.reviewComment}"</Text>
        </Alert>
      )}

      {/* Current Period Status Cards */}
      <SimpleGrid cols={{ base: 1, sm: 2, md: 4 }} spacing="md">
        {/* Period Status */}
        <Paper withBorder p="md" radius="md">
          <Group justify="space-between">
            <div>
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>Period Status</Text>
              <Badge color={STATUS_COLORS[currentPeriod.status] ?? 'gray'} size="lg" mt={4}>
                {STATUS_LABELS[currentPeriod.status] ?? currentPeriod.status}
              </Badge>
            </div>
            <ThemeIcon color={STATUS_COLORS[currentPeriod.status] ?? 'gray'} variant="light" size="lg" radius="md">
              {currentPeriod.status === 'approved' ? <IconCheck size={20} /> :
               currentPeriod.status === 'submitted' ? <IconSend size={20} /> :
               <IconClock size={20} />}
            </ThemeIcon>
          </Group>
        </Paper>

        {/* Hours This Period */}
        <Paper withBorder p="md" radius="md">
          <Group justify="space-between">
            <div>
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>Hours This Period</Text>
              <Text size="xl" fw={700} mt={4}>{currentPeriod.totalHoursEntered.toFixed(1)}</Text>
            </div>
            <ThemeIcon color="blue" variant="light" size="lg" radius="md">
              <IconClock size={20} />
            </ThemeIcon>
          </Group>
        </Paper>

        {/* Days Completed */}
        <Paper withBorder p="md" radius="md">
          <Group justify="space-between" mb="xs">
            <div>
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>Days Completed</Text>
              <Text size="xl" fw={700} mt={4}>
                {currentPeriod.daysWithEntries} / {currentPeriod.expectedWorkdays}
              </Text>
            </div>
            <ThemeIcon color={completionColor} variant="light" size="lg" radius="md">
              <IconCalendar size={20} />
            </ThemeIcon>
          </Group>
          <Progress value={completionPct} color={completionColor} size="sm" mt="xs" />
        </Paper>

        {/* Submission Deadline */}
        <Paper withBorder p="md" radius="md">
          <Group justify="space-between">
            <div>
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>Submit By</Text>
              <Text size="lg" fw={700} mt={4}>{currentPeriod.submissionDeadline}</Text>
              {currentPeriod.canSubmitToday && currentPeriod.status === 'draft' && (
                <Text size="xs" c="green" fw={500}>Ready to submit</Text>
              )}
              {!currentPeriod.canSubmitToday && currentPeriod.daysRemaining > 0 && (
                <Text size="xs" c="dimmed">{currentPeriod.daysRemaining} workdays remaining</Text>
              )}
            </div>
            <ThemeIcon
              color={currentPeriod.canSubmitToday ? 'green' : 'gray'}
              variant="light"
              size="lg"
              radius="md"
            >
              <IconSend size={20} />
            </ThemeIcon>
          </Group>
        </Paper>
      </SimpleGrid>

      {/* Recent Periods History */}
      {recentPeriods.length > 0 && (
        <Paper withBorder p="md" radius="md">
          <Group mb="sm">
            <IconHistory size={18} />
            <Text fw={600} size="sm">Recent Periods</Text>
          </Group>
          <Table striped highlightOnHover size="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Period</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Hours</Table.Th>
                <Table.Th>Submitted</Table.Th>
                <Table.Th>Reviewed</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {recentPeriods.map((rp) => (
                <Table.Tr key={rp.periodStart.toString()}>
                  <Table.Td>{rp.periodLabel}</Table.Td>
                  <Table.Td>
                    <Badge
                      color={STATUS_COLORS[rp.status] ?? 'gray'}
                      variant="light"
                      size="sm"
                    >
                      {STATUS_LABELS[rp.status] ?? rp.status}
                    </Badge>
                  </Table.Td>
                  <Table.Td>{rp.totalHours.toFixed(1)}</Table.Td>
                  <Table.Td>
                    {rp.submittedAt ? dayjs(rp.submittedAt).format('MMM D') : '—'}
                  </Table.Td>
                  <Table.Td>
                    {rp.reviewedAt ? dayjs(rp.reviewedAt).format('MMM D') : '—'}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Paper>
      )}
    </Stack>
  );
}
```

---

### Phase C: Integrate Dashboard into Timesheet Page (C1–C3)

#### C1. Modify `src/types/timesheet.ts` — Add dashboard data to page data

Add to the `TimesheetPageData` interface:

```typescript
import type { EmployeeDashboardData } from '@/server/actions/employee-dashboard';
```

Add the field:

```typescript
dashboardData?: EmployeeDashboardData;
```

#### C2. Modify `src/app/(app)/timesheet/page.tsx` — Fetch dashboard data

Import the dashboard query:

```typescript
import { getEmployeeDashboardData } from '@/server/actions/employee-dashboard';
```

Add the dashboard data fetch alongside existing parallel fetches:

```typescript
const dashboardData = await getEmployeeDashboardData(userId);
```

Add to `pageData`:

```typescript
dashboardData,
```

#### C3. Modify `src/components/timesheet/BiWeeklyTimesheetClient.tsx` — Render dashboard

Import the dashboard component:

```typescript
import { TimesheetDashboard } from '@/components/timesheet/TimesheetDashboard';
```

In the `TimesheetContent` function, add the dashboard ABOVE the `<PayPeriodSelector />`:

```tsx
{initialData.dashboardData && (
  <TimesheetDashboard data={initialData.dashboardData} />
)}
```

**Note:** The dashboard needs access to `initialData` which is available in the `BiWeeklyTimesheetClient` component but not in `TimesheetContent`. Either pass it as a prop to `TimesheetContent`, or render the dashboard at the `BiWeeklyTimesheetClient` level, outside the `TimesheetProvider`:

```tsx
export function BiWeeklyTimesheetClient({ initialData }: Props) {
  // ... existing useEffect ...

  return (
    <>
      {initialData.dashboardData && (
        <Container fluid px="md" pt="xl">
          <TimesheetDashboard data={initialData.dashboardData} />
        </Container>
      )}
      <TimesheetProvider initialData={initialData}>
        <TimesheetContent />
      </TimesheetProvider>
    </>
  );
}
```

Import `Container` from `@mantine/core` if not already imported.

---

## 4. Verification

### 4a. Build Check

```bash
npm run build
```

### 4b. Dashboard Checks

| Check | Expected Result |
|---|---|
| Timesheet page loads | Dashboard cards visible above the timesheet grid |
| Period status card | Shows current period status (Draft/Submitted/Approved/Rejected) |
| Hours card | Shows total hours entered this period |
| Days completed | Shows X/Y workdays with progress bar |
| Submission deadline | Shows period end date + "Ready to submit" or "X workdays remaining" |
| Rejected period | Shows red alert with supervisor's rejection comment |
| Recent periods table | Shows last 5 periods with status, hours, dates |
| No recent periods | Table hidden (no error) |
| Mobile responsive | Cards stack vertically on small screens |

### 4c. Common Errors to Watch For

| Error | Root Cause | Fix |
|---|---|---|
| `dashboardData` undefined | Not fetched in page.tsx | Verify `getEmployeeDashboardData` is called and passed |
| Hours count wrong | Counting superseded revisions | Query uses MAX revision subquery |
| `isSameOrAfter` not available | dayjs plugin not extended | Import and extend in employee-dashboard.ts |
| Dashboard breaks existing timesheet | Rendered inside TimesheetProvider | Render OUTSIDE the provider (at BiWeeklyTimesheetClient level) |
| Performance slow | Too many DB queries for recent periods | Consider combining into fewer queries if >5 periods |
