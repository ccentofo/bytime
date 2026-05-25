# Blueprint: Uncompensated Overtime Tracking (FLSA Exempt Total Time Accounting)

## 1. Architectural Overview & DCAA Impact

### The CONTEXT.md Requirement

> "Total Time Accounting: All hours worked must be recorded, including unpaid/uncompensated overtime for FLSA-exempt employees."

This is a **NON-NEGOTIABLE** DCAA compliance requirement that is currently missing from the system.

### What is Uncompensated Overtime?

FLSA-exempt (salaried) employees are not paid overtime. However, DCAA requires that **all hours actually worked** be recorded — not just the 40 hours per week they're compensated for. This is because:

1. **Indirect rate calculations depend on total actual hours.** If an exempt employee works 50 hours but only records 40, the contractor's indirect rates are inflated (overhead is spread over fewer hours), making their bids less competitive and potentially non-compliant.

2. **Effective hourly rate calculation.** An employee paid $100,000/year salary working 50 hours/week has an effective rate of ~$38.46/hr, not $48.08/hr (based on 40 hrs). DCAA uses actual hours to validate that billed rates are reasonable.

3. **CAS 418 compliance.** Cost Accounting Standard 418 requires consistent allocation of direct and indirect costs. Under-reporting hours distorts this allocation.

### How It Works in Practice

```
Employee "Jane" is FLSA Exempt (salaried):
  - Salary: $100,000/year
  - Assigned to CLIN 0001 (Contract A) and CLIN 0002 (indirect/overhead)

Week of May 18:
  - Monday:    8 hrs on CLIN 0001 (direct, billable)
  - Tuesday:   8 hrs on CLIN 0001 (direct, billable)
  - Wednesday: 10 hrs on CLIN 0001 (direct, billable — 2 hrs uncompensated OT)
  - Thursday:  8 hrs on CLIN 0001 (direct, billable)
  - Friday:    8 hrs on CLIN 0001 (direct, billable)
  - Saturday:  4 hrs on CLIN 0001 (direct, billable — all uncompensated OT)
  
  Total: 46 hours worked, 40 compensated, 6 uncompensated
  All 46 hours MUST be recorded in the timesheet.
```

### Design Decisions

1. **FLSA status is a user-level attribute** — Added to the `users` table as `flsaExempt: boolean` (default: `false`). Non-exempt employees are not affected by any changes.

2. **No changes to `timesheetEntries`** — Hours are hours. The system already records all hours entered. What's new is **enforcement** that exempt employees cannot submit without recording total actual hours, and **reporting** that distinguishes compensated vs. uncompensated.

3. **Weekly hours threshold** — For FLSA-exempt employees, if weekly total hours exceed 40, the excess is automatically classified as "uncompensated overtime" in reports. No separate entry type needed.

4. **Minimum hours warning** — If an exempt employee records fewer than 40 hours in a week (without approved leave), a warning is shown. This is a soft warning, not a hard block, because some weeks may legitimately have fewer hours (holidays, PTO, etc.).

5. **Submit validation** — When an exempt employee submits, the system validates that total period hours are reasonable (not suspiciously low). A warning is shown but submission is not blocked.

---

## 2. File Topology

```
Files to MODIFY:
├── src/db/schema.ts                                     ← Add flsaExempt column to users table
├── src/server/actions/users.ts                          ← Include flsaExempt in user queries/updates
├── src/server/actions/reports.ts                        ← Add overtime breakdown to reports
├── src/app/(app)/admin/users/UsersClient.tsx             ← Add FLSA toggle to user management
├── src/components/timesheet/TimesheetToolbar.tsx         ← Add overtime summary + submit warning
├── src/components/timesheet/SubmitModal.tsx              ← Add overtime disclosure in certification
├── src/types/timesheet.ts                               ← Add flsaExempt to TimesheetPageData
├── src/app/(app)/timesheet/page.tsx                     ← Pass flsaExempt to client
├── src/components/timesheet/TimesheetContext.tsx         ← Add flsaExempt to state

Files NOT TOUCHED (guardrail — DO NOT MODIFY):
├── src/auth.ts                                          ← ❌ DO NOT MODIFY
├── src/middleware.ts                                    ← ❌ DO NOT MODIFY
├── src/components/timesheet/BiWeeklyTable.tsx            ← ❌ DO NOT MODIFY
├── src/components/timesheet/BiWeeklyTimesheetClient.tsx  ← ❌ DO NOT MODIFY
├── src/components/timesheet/cells/*                      ← ❌ DO NOT MODIFY
├── src/components/timesheet/DailyNoteModal.tsx           ← ❌ DO NOT MODIFY
├── src/components/timesheet/ReasonModal.tsx              ← ❌ DO NOT MODIFY
├── src/components/timesheet/PayPeriodSelector.tsx        ← ❌ DO NOT MODIFY
├── src/components/shell/*                               ← ❌ DO NOT MODIFY
├── src/server/actions/timesheet.ts                      ← ❌ DO NOT MODIFY
├── src/server/actions/periods.ts                        ← ❌ DO NOT MODIFY
├── src/server/actions/contracts.ts                      ← ❌ DO NOT MODIFY
├── src/server/actions/clins.ts                          ← ❌ DO NOT MODIFY
├── src/server/actions/assignments.ts                    ← ❌ DO NOT MODIFY
├── src/server/actions/password.ts                       ← ❌ DO NOT MODIFY
├── src/server/actions/notifications.ts                  ← ❌ DO NOT MODIFY
├── src/server/actions/supervisor-scope.ts               ← ❌ DO NOT MODIFY
├── src/server/actions/dashboard.ts                      ← ❌ DO NOT MODIFY
├── src/server/actions/audit.ts                          ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/contracts/*                       ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/assignments/*                     ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/approvals/*                       ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/audit-trail/*                     ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/dashboard/*                       ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/labor-categories/*                 ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/reports/*                          ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/notifications/*                    ← ❌ DO NOT MODIFY
├── src/lib/offline/*                                     ← ❌ DO NOT MODIFY
├── src/lib/email/*                                       ← ❌ DO NOT MODIFY
```

---

## 3. Step-by-Step Execution Plan

> **⚠️ CRITICAL GUARDRAILS FOR THE EXECUTION AGENT:**
> - **DO NOT** search, grep, or read files inside `node_modules/`, `.next/`, or `dist/`.
> - **DO NOT** modify any files listed in the "DO NOT MODIFY" section above.
> - Use **Mantine v9** imports only (`@mantine/core`, `@mantine/hooks`, `@mantine/notifications`).
> - Use **Drizzle ORM** for all database operations.
> - Follow the step order exactly. Each step builds on the previous one.
> - **After completing each phase, run `npm run build` to verify zero errors.**
> - **Key principle:** The `timesheetEntries` table is NOT modified. Overtime is derived from existing hours data.

---

### Phase A: Schema Update (A1)

#### A1. Modify `src/db/schema.ts` — Add `flsaExempt` column to users table

Add this column after the `passwordChangedAt` column and before `createdAt`:

```typescript
flsaExempt: boolean('flsa_exempt').notNull().default(false), // FLSA exempt = salaried, must record all hours including uncompensated OT
```

The full `users` table should become:

```typescript
export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  fullName: varchar('full_name', { length: 255 }).notNull(),
  role: userRoleEnum('role').notNull().default('employee'),
  isActive: boolean('is_active').notNull().default(true),
  passwordHash: varchar('password_hash', { length: 255 }),
  passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),
  flsaExempt: boolean('flsa_exempt').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

Push the schema change:

```bash
npx drizzle-kit push
```

---

### Phase B: Update User Management (B1–B2)

#### B1. Modify `src/server/actions/users.ts` — Add `flsaExempt` to update function

Update the `updateUser` function signature to accept `flsaExempt`:

Find:

```typescript
export async function updateUser(id: string, data: {
  fullName?: string;
  email?: string;
  role?: 'admin' | 'supervisor' | 'employee';
  isActive?: boolean;
}) {
```

Replace with:

```typescript
export async function updateUser(id: string, data: {
  fullName?: string;
  email?: string;
  role?: 'admin' | 'supervisor' | 'employee';
  isActive?: boolean;
  flsaExempt?: boolean;
}) {
```

No other changes needed to this file — the spread operator `{ ...data, updatedAt: new Date() }` already handles the new field.

#### B2. Modify `src/app/(app)/admin/users/UsersClient.tsx` — Add FLSA toggle

**B2a.** Update the `User` type to include `flsaExempt`:

Find:

```typescript
type User = {
  id: string;
  email: string;
  fullName: string;
  role: 'admin' | 'supervisor' | 'employee';
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};
```

Replace with:

```typescript
type User = {
  id: string;
  email: string;
  fullName: string;
  role: 'admin' | 'supervisor' | 'employee';
  isActive: boolean;
  flsaExempt: boolean;
  createdAt: Date;
  updatedAt: Date;
};
```

**B2b.** Add a new column to the MRT table for FLSA status. Find the `columns` array and add this column AFTER the `isActive` column:

```typescript
{
  accessorKey: 'flsaExempt',
  header: 'FLSA Exempt',
  Cell: ({ row }) => (
    <Switch
      checked={row.original.flsaExempt}
      onChange={() => handleToggleFlsaExempt(row.original)}
      disabled={isPending}
      size="sm"
      label={row.original.flsaExempt ? 'Exempt' : 'Non-Exempt'}
    />
  ),
  size: 140,
},
```

**B2c.** Add the `handleToggleFlsaExempt` handler. Add this function after the existing `handleToggleActive`:

```typescript
function handleToggleFlsaExempt(user: User) {
  startTransition(async () => {
    const newExempt = !user.flsaExempt;
    await updateUser(user.id, { flsaExempt: newExempt });
    const refreshed = await getUsers();
    setUsers(refreshed as User[]);
    notifications.show({
      title: newExempt ? 'FLSA Exempt' : 'FLSA Non-Exempt',
      message: `${user.fullName} is now ${newExempt ? 'FLSA Exempt (salaried)' : 'FLSA Non-Exempt (hourly)'}.`,
      color: newExempt ? 'blue' : 'gray',
    });
  });
}
```

---

### Phase C: Pass FLSA Status to Timesheet (C1–C3)

#### C1. Modify `src/types/timesheet.ts` — Add `flsaExempt` to page data and state

**C1a.** Add `flsaExempt` to `TimesheetPageData`:

Find:

```typescript
export interface TimesheetPageData {
  userId: string;
  chargeCodes: ChargeCode[];
  entries: TimesheetEntry[];
  periodStart: Date;
  revisions?: Record<string, number>;
  periodStatus?: PeriodStatus;
}
```

Replace with:

```typescript
export interface TimesheetPageData {
  userId: string;
  chargeCodes: ChargeCode[];
  entries: TimesheetEntry[];
  periodStart: Date;
  revisions?: Record<string, number>;
  periodStatus?: PeriodStatus;
  flsaExempt?: boolean;
}
```

**C1b.** Add `flsaExempt` to `TimesheetState`:

Find the `TimesheetState` interface and add after `periodStatus`:

```typescript
flsaExempt: boolean; // true if user is FLSA exempt (salaried)
```

#### C2. Modify `src/app/(app)/timesheet/page.tsx` — Fetch and pass FLSA status

Read the current file first. Then add the FLSA status to the page data. After the existing user/session fetching, query the user's `flsaExempt` field.

Since the `auth()` session doesn't include `flsaExempt`, fetch it from the database. Add this import at the top:

```typescript
import { getUserByEmail } from '@/server/actions/users';
```

Then after the `session` check, fetch the full user record:

```typescript
const fullUser = await getUserByEmail(session.user.email!);
```

And add `flsaExempt` to the `pageData` object:

```typescript
flsaExempt: fullUser?.flsaExempt ?? false,
```

**Important:** If the page currently reads `userId` from `session.user.id`, you can also get `flsaExempt` from a direct DB query. The simplest approach is to use the existing `getUserByEmail` since the email is already available from the session.

#### C3. Modify `src/components/timesheet/TimesheetContext.tsx` — Add `flsaExempt` to initial state

In the `TimesheetProvider`, update the `initialState` to include `flsaExempt`:

Find the `initialState` object inside `TimesheetProvider` and add:

```typescript
flsaExempt: initialData.flsaExempt ?? false,
```

This field is read-only in the context (it doesn't change during the session), so no reducer case is needed.

---

### Phase D: Overtime Summary in Toolbar (D1)

#### D1. Modify `src/components/timesheet/TimesheetToolbar.tsx` — Add overtime information for exempt employees

**D1a.** Access `flsaExempt` from state. The `useTimesheet()` hook provides `state` which now includes `flsaExempt`.

**D1b.** Calculate weekly overtime metrics from the current entries. Add this computation after the existing `canSubmit` calculation:

```typescript
// Overtime calculations for FLSA exempt employees
const overtimeInfo = useMemo(() => {
  if (!state.flsaExempt) return null;

  const totalPeriodHours = state.entries.reduce(
    (sum, entry) => sum + entry.hours.reduce((a, b) => a + b, 0),
    0
  );

  // Calculate weekly totals within the period
  // Semi-monthly periods span ~2 weeks; compute day-by-day totals grouped by ISO week
  const dailyTotals: number[] = [];
  const numDaysInPeriod = state.entries[0]?.hours.length ?? 0;
  for (let i = 0; i < numDaysInPeriod; i++) {
    let dayTotal = 0;
    for (const entry of state.entries) {
      dayTotal += entry.hours[i] ?? 0;
    }
    dailyTotals.push(dayTotal);
  }

  // Group by week (Mon-Sun) and calculate compensated vs uncompensated
  const weeklyTotals: { weekLabel: string; total: number; compensated: number; uncompensated: number }[] = [];
  let currentWeekStart: dayjs.Dayjs | null = null;
  let currentWeekHours = 0;
  let currentWeekLabel = '';

  for (let i = 0; i < numDaysInPeriod; i++) {
    const date = dayjs(state.periodStart).add(i, 'day');
    const weekStart = date.startOf('week'); // Sunday

    if (!currentWeekStart || !weekStart.isSame(currentWeekStart, 'day')) {
      // Save previous week
      if (currentWeekStart !== null) {
        weeklyTotals.push({
          weekLabel: currentWeekLabel,
          total: Math.round(currentWeekHours * 100) / 100,
          compensated: Math.min(currentWeekHours, 40),
          uncompensated: Math.max(0, Math.round((currentWeekHours - 40) * 100) / 100),
        });
      }
      currentWeekStart = weekStart;
      currentWeekHours = 0;
      currentWeekLabel = `Week of ${date.format('MMM D')}`;
    }
    currentWeekHours += dailyTotals[i];
  }
  // Save last week
  if (currentWeekStart !== null) {
    weeklyTotals.push({
      weekLabel: currentWeekLabel,
      total: Math.round(currentWeekHours * 100) / 100,
      compensated: Math.min(currentWeekHours, 40),
      uncompensated: Math.max(0, Math.round((currentWeekHours - 40) * 100) / 100),
    });
  }

  const totalUncompensated = weeklyTotals.reduce((sum, w) => sum + w.uncompensated, 0);
  const hasLowHoursWarning = weeklyTotals.some((w) => w.total > 0 && w.total < 40);

  return {
    totalPeriodHours: Math.round(totalPeriodHours * 100) / 100,
    totalUncompensated: Math.round(totalUncompensated * 100) / 100,
    weeklyTotals,
    hasLowHoursWarning,
  };
}, [state.entries, state.periodStart, state.flsaExempt]);
```

Add this import at the top of the file:

```typescript
import { useMemo } from 'react';
import type { Dayjs } from 'dayjs';
```

**D1c.** Add the overtime summary UI. Add this JSX block AFTER the status badge `<Group>` and BEFORE the `<ReasonModal>`:

```tsx
{/* Overtime summary for FLSA exempt employees */}
{state.flsaExempt && overtimeInfo && overtimeInfo.totalPeriodHours > 0 && (
  <Paper withBorder p="xs" mb="sm" radius="sm">
    <Group justify="space-between" wrap="wrap">
      <Group gap="md">
        <Text size="sm" fw={600}>
          Total Period Hours: {overtimeInfo.totalPeriodHours.toFixed(2)}
        </Text>
        {overtimeInfo.totalUncompensated > 0 && (
          <Badge color="orange" variant="light" size="lg">
            {overtimeInfo.totalUncompensated.toFixed(2)} hrs uncompensated OT
          </Badge>
        )}
      </Group>
      {overtimeInfo.hasLowHoursWarning && (
        <Text size="xs" c="orange" fw={500}>
          ⚠ Some weeks have fewer than 40 hours — ensure all time is recorded
        </Text>
      )}
    </Group>
  </Paper>
)}
```

Add `Paper` to the Mantine imports at the top of the file:

```typescript
import { Button, Group, Badge, Text, Alert, Paper } from '@mantine/core';
```

---

### Phase E: Submit Modal Overtime Disclosure (E1)

#### E1. Modify `src/components/timesheet/SubmitModal.tsx` — Add overtime acknowledgment for exempt employees

**E1a.** Update the Props type to accept `flsaExempt` and overtime info:

Find:

```typescript
type Props = {
  opened: boolean;
  onClose: () => void;
  onConfirm: (comment?: string) => Promise<void>;
  isSaving: boolean;
  periodLabel: string;
};
```

Replace with:

```typescript
type Props = {
  opened: boolean;
  onClose: () => void;
  onConfirm: (comment?: string) => Promise<void>;
  isSaving: boolean;
  periodLabel: string;
  flsaExempt?: boolean;
  totalPeriodHours?: number;
  uncompensatedHours?: number;
};
```

**E1b.** Update the component signature:

```typescript
export function SubmitModal({ opened, onClose, onConfirm, isSaving, periodLabel, flsaExempt, totalPeriodHours, uncompensatedHours }: Props) {
```

**E1c.** Add overtime disclosure in the modal body. Find the existing `<Alert>` with the certification text. After it (before the `<Textarea>`), add:

```tsx
{flsaExempt && (
  <Paper withBorder p="sm" radius="sm">
    <Text size="sm" fw={600} mb={4}>FLSA Exempt — Total Time Accounting:</Text>
    <Text size="sm">Total Hours Recorded: <strong>{(totalPeriodHours ?? 0).toFixed(2)}</strong></Text>
    {(uncompensatedHours ?? 0) > 0 && (
      <Text size="sm">Uncompensated Overtime: <strong>{(uncompensatedHours ?? 0).toFixed(2)} hours</strong></Text>
    )}
    <Text size="xs" c="dimmed" mt={4}>
      As an FLSA-exempt employee, you are required to record all hours actually worked,
      including any uncompensated overtime, per DCAA total time accounting requirements.
    </Text>
  </Paper>
)}
```

Add `Paper` to the Mantine imports if not already present.

**E1d.** Update the certification checkbox text for exempt employees. Find the `<Checkbox>` label:

```typescript
label="I certify that the hours recorded on this timesheet are a true and accurate representation of the time I worked during this pay period."
```

Replace with:

```typescript
label={flsaExempt
  ? "I certify that the hours recorded on this timesheet represent ALL time actually worked during this pay period, including any uncompensated overtime, as required by DCAA total time accounting standards."
  : "I certify that the hours recorded on this timesheet are a true and accurate representation of the time I worked during this pay period."
}
```

---

### Phase F: Wire SubmitModal Props (F1)

#### F1. Modify `src/components/timesheet/TimesheetToolbar.tsx` — Pass overtime props to SubmitModal

Find the `<SubmitModal>` component invocation:

```tsx
<SubmitModal
  opened={submitModalOpen}
  onClose={() => setSubmitModalOpen(false)}
  onConfirm={handleSubmitConfirm}
  isSaving={state.isSaving}
  periodLabel={periodLabel}
/>
```

Replace with:

```tsx
<SubmitModal
  opened={submitModalOpen}
  onClose={() => setSubmitModalOpen(false)}
  onConfirm={handleSubmitConfirm}
  isSaving={state.isSaving}
  periodLabel={periodLabel}
  flsaExempt={state.flsaExempt}
  totalPeriodHours={overtimeInfo?.totalPeriodHours}
  uncompensatedHours={overtimeInfo?.totalUncompensated}
/>
```

---

### Phase G: Reporting — Overtime Breakdown (G1)

#### G1. Modify `src/server/actions/reports.ts` — Add overtime columns to employee summary

**G1a.** Update the `EmployeeSummaryEntry` interface to include overtime breakdown:

Find:

```typescript
export interface EmployeeSummaryEntry {
  employeeName: string;
  contractName: string;
  contractNumber: string;
  clinNumber: string;
  totalHours: number;
  totalCost: number;
}
```

Replace with:

```typescript
export interface EmployeeSummaryEntry {
  employeeName: string;
  contractName: string;
  contractNumber: string;
  clinNumber: string;
  totalHours: number;
  totalCost: number;
  flsaExempt: boolean;
}
```

**G1b.** Update the `getEmployeeSummaryReport` query to include FLSA status. Add `users.flsaExempt` to the select:

Find in the `.select()`:

```typescript
employeeName: users.fullName,
```

Add after it:

```typescript
flsaExempt: users.flsaExempt,
```

**G1c.** Update the `.groupBy()` to include `users.flsaExempt`:

Find:

```typescript
.groupBy(users.fullName, contracts.name, contracts.contractNumber, clins.clinNumber)
```

Replace with:

```typescript
.groupBy(users.fullName, users.flsaExempt, contracts.name, contracts.contractNumber, clins.clinNumber)
```

**G1d.** Update the return mapping to include `flsaExempt`:

Find:

```typescript
return rows.map((row) => ({
  employeeName: row.employeeName,
  contractName: row.contractName,
  contractNumber: row.contractNumber,
  clinNumber: row.clinNumber,
  totalHours: Math.round(Number(row.totalHours) * 100) / 100,
  totalCost: Math.round(Number(row.totalCost) * 100) / 100,
}));
```

Replace with:

```typescript
return rows.map((row) => ({
  employeeName: row.employeeName,
  contractName: row.contractName,
  contractNumber: row.contractNumber,
  clinNumber: row.clinNumber,
  totalHours: Math.round(Number(row.totalHours) * 100) / 100,
  totalCost: Math.round(Number(row.totalCost) * 100) / 100,
  flsaExempt: row.flsaExempt,
}));
```

---

## 4. Verification

### 4a. Build & Schema Check

```bash
npx drizzle-kit push
npm run build
```

Must complete with **zero errors**.

### 4b. Functional Checks

| Check | Expected Result |
|---|---|
| **User Management table** | Shows "FLSA Exempt" column with toggle switches |
| **Toggle FLSA Exempt on** | Notification: "Jane Smith is now FLSA Exempt (salaried)" |
| **Timesheet for non-exempt user** | No overtime summary, no changes to submit flow |
| **Timesheet for exempt user (40 hrs)** | Shows "Total Period Hours: 40.00" — no uncompensated OT |
| **Timesheet for exempt user (46 hrs)** | Shows "Total Period Hours: 46.00" + "6.00 hrs uncompensated OT" badge |
| **Timesheet for exempt user (32 hrs)** | Shows low-hours warning: "Some weeks have fewer than 40 hours" |
| **Submit modal for exempt user** | Shows FLSA overtime disclosure section + enhanced certification text |
| **Submit modal for non-exempt user** | Standard certification text, no FLSA section |
| **Employee Summary Report** | Includes `flsaExempt` field for downstream use |

### 4c. DCAA Compliance Verification

| DCAA Requirement | How Verified |
|---|---|
| Total time accounting | Exempt employees see overtime summary; certification text requires acknowledgment of all time |
| Uncompensated OT recording | UI calculates and displays uncompensated hours (weekly total > 40) |
| Audit trail | All hours (compensated + uncompensated) stored in append-only `timesheetEntries` — no separate tracking needed |

### 4d. Common Errors to Watch For

| Error | Root Cause | Fix |
|---|---|---|
| `column "flsa_exempt" does not exist` | Schema not pushed | Run `npx drizzle-kit push` |
| `useMemo` not imported | Missing import | Add `useMemo` to React imports in TimesheetToolbar |
| `Paper` not imported | Missing Mantine import | Add `Paper` to imports in TimesheetToolbar and SubmitModal |
| `flsaExempt` undefined in state | Not passed from page | Verify `timesheet/page.tsx` includes `flsaExempt` in pageData |
| Overtime calculation wrong at period boundaries | Week spans two periods | The calculation groups by ISO week within the period — partial weeks at boundaries are expected |
| `getUserByEmail` not imported in timesheet page | Missing import | Add import from `@/server/actions/users` |
