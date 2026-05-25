# Blueprint: Period Completeness Validation — Total Time Accounting Enforcement

## 1. Architectural Overview & DCAA Impact

### The DCAA Requirement

**CAS 418 — Total Time Accounting:** Every working day in a pay period must have hours accounted for. DCAA auditors check for "gaps" — days where an employee was expected to work but recorded zero hours without a leave code.

**FAR 31.201-1 — Daily Time Entry:** Time must be recorded daily. If an employee submits a timesheet with 3 out of 10 workdays showing zero hours and no leave, auditors will flag this as a compliance gap.

### The Problem

The current `submitPeriod()` function in `src/server/actions/periods.ts` validates:
- ✅ Period must be on/after the last day of the period
- ✅ Status must be draft or rejected
- ✅ Timesheet must have at least some hours recorded (client-side)

It does NOT validate:
- ❌ Whether every work day in the period has at least some hours
- ❌ Whether total period hours meet a minimum threshold for exempt employees
- ❌ Whether there are suspicious patterns (e.g., all zeros on weekdays)

### Design: Warning-Based Validation (Not Hard Block)

**Key decision:** Period completeness validation uses **warnings, not hard blocks.** There are legitimate reasons for zero-hour workdays (company closure, personal day covered by verbal approval, etc.). Hard-blocking submission would cause more problems than it solves.

The validation produces warnings that are:
1. Displayed in the **SubmitModal** before the employee certifies
2. Logged with the submission for audit purposes (stored in `submittedComment`)
3. Visible to the **supervisor** during the review process

This preserves employee flexibility while creating an auditable record that the employee acknowledged the gaps.

### Validation Rules

| Rule | Trigger | Severity | Description |
|---|---|---|---|
| **Missing Workdays** | Weekday (Mon-Fri) with 0 hours total | ⚠️ Warning | "You have X workdays with no hours recorded" |
| **Low Total Hours (Exempt)** | FLSA-exempt employee with < 40 hrs/week | ⚠️ Warning | "Week of {date} has only {X} hours (expected 40+ for exempt)" |
| **Empty Period** | Total period hours = 0 | 🔴 Block | Cannot submit a completely empty timesheet |
| **Excessive Hours** | Any single day > 16 hours | ⚠️ Warning | "You have {X} hours on {date} — please verify" |

---

## 2. File Topology

```
Files to MODIFY:
├── src/components/timesheet/SubmitModal.tsx          ← Add completeness warnings display
├── src/components/timesheet/TimesheetToolbar.tsx     ← Compute and pass completeness warnings
├── src/server/actions/periods.ts                    ← Add server-side completeness check on submit

Files NOT TOUCHED (guardrail — DO NOT MODIFY):
├── src/db/schema.ts                                 ← ❌ DO NOT MODIFY
├── src/auth.ts                                      ← ❌ DO NOT MODIFY
├── src/middleware.ts                                ← ❌ DO NOT MODIFY
├── src/components/timesheet/BiWeeklyTable.tsx        ← ❌ DO NOT MODIFY
├── src/components/timesheet/BiWeeklyTimesheetClient.tsx ← ❌ DO NOT MODIFY
├── src/components/timesheet/TimesheetContext.tsx     ← ❌ DO NOT MODIFY
├── src/components/timesheet/cells/*                  ← ❌ DO NOT MODIFY
├── src/components/timesheet/DailyNoteModal.tsx       ← ❌ DO NOT MODIFY
├── src/components/timesheet/ReasonModal.tsx          ← ❌ DO NOT MODIFY
├── src/components/timesheet/PayPeriodSelector.tsx    ← ❌ DO NOT MODIFY
├── src/components/shell/*                           ← ❌ DO NOT MODIFY
├── src/server/actions/timesheet.ts                  ← ❌ DO NOT MODIFY
├── src/server/actions/contracts.ts                  ← ❌ DO NOT MODIFY
├── src/server/actions/clins.ts                      ← ❌ DO NOT MODIFY
├── src/server/actions/assignments.ts                ← ❌ DO NOT MODIFY
├── src/server/actions/users.ts                      ← ❌ DO NOT MODIFY
├── src/server/actions/password.ts                   ← ❌ DO NOT MODIFY
├── src/server/actions/dashboard.ts                  ← ❌ DO NOT MODIFY
├── src/server/actions/audit.ts                      ← ❌ DO NOT MODIFY
├── src/server/actions/reports.ts                    ← ❌ DO NOT MODIFY
├── src/server/actions/notifications.ts              ← ❌ DO NOT MODIFY
├── src/server/actions/supervisor-scope.ts            ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/**                            ← ❌ DO NOT MODIFY
├── src/app/(app)/timesheet/page.tsx                  ← ❌ DO NOT MODIFY
├── src/types/timesheet.ts                           ← ❌ DO NOT MODIFY
├── src/lib/**                                       ← ❌ DO NOT MODIFY
```

---

## 3. Step-by-Step Execution Plan

> **⚠️ CRITICAL GUARDRAILS FOR THE EXECUTION AGENT:**
> - **DO NOT** search, grep, or read files inside `node_modules/`, `.next/`, or `dist/`.
> - **DO NOT** modify any files listed in the "DO NOT MODIFY" section above.
> - Use **Mantine v9** imports only (`@mantine/core`, `@mantine/hooks`).
> - Follow the step order exactly. Each step builds on the previous one.
> - **After completing each phase, run `npm run build` to verify zero errors.**
> - **Key principle:** Warnings do NOT block submission — they inform the employee and are recorded for audit. Only a completely empty timesheet (zero total hours) is blocked.

---

### Phase A: Compute Completeness Warnings in TimesheetToolbar (A1)

#### A1. Modify `src/components/timesheet/TimesheetToolbar.tsx` — Add completeness validation

**A1a.** Add a `completenessWarnings` computed value using `useMemo`. Add this AFTER the existing `overtimeInfo` useMemo block (around line 109):

```typescript
// Period completeness validation warnings
const completenessWarnings = useMemo(() => {
  const warnings: string[] = [];
  const numDaysInPeriod = state.entries[0]?.hours.length ?? 0;
  if (numDaysInPeriod === 0) return warnings;

  // Calculate daily totals across all charge codes
  const dailyTotals: number[] = [];
  for (let i = 0; i < numDaysInPeriod; i++) {
    let dayTotal = 0;
    for (const entry of state.entries) {
      dayTotal += entry.hours[i] ?? 0;
    }
    dailyTotals.push(Math.round(dayTotal * 100) / 100);
  }

  // Check for missing workdays (weekdays with 0 hours)
  const missingDays: string[] = [];
  for (let i = 0; i < numDaysInPeriod; i++) {
    const date = dayjs(state.periodStart).add(i, 'day');
    const dow = date.day(); // 0=Sun, 6=Sat
    const isWeekday = dow >= 1 && dow <= 5;
    const isPastOrToday = date.isBefore(dayjs(), 'day') || date.isSame(dayjs(), 'day');

    if (isWeekday && isPastOrToday && dailyTotals[i] === 0) {
      missingDays.push(date.format('ddd MMM D'));
    }
  }

  if (missingDays.length > 0) {
    warnings.push(
      `${missingDays.length} workday${missingDays.length !== 1 ? 's' : ''} with no hours recorded: ${missingDays.join(', ')}`
    );
  }

  // Check for excessive hours on any single day (> 16 hours)
  for (let i = 0; i < numDaysInPeriod; i++) {
    if (dailyTotals[i] > 16) {
      const date = dayjs(state.periodStart).add(i, 'day');
      warnings.push(
        `${dailyTotals[i].toFixed(2)} hours recorded on ${date.format('ddd MMM D')} — please verify this is correct`
      );
    }
  }

  // Total period hours
  const totalHours = dailyTotals.reduce((sum, h) => sum + h, 0);

  // Check for very low total hours (less than 50% of expected workdays × 8)
  const workdayCount = Array.from({ length: numDaysInPeriod }, (_, i) => {
    const dow = dayjs(state.periodStart).add(i, 'day').day();
    return dow >= 1 && dow <= 5 ? 1 : 0;
  }).reduce((a, b) => a + b, 0);

  const expectedMinHours = workdayCount * 4; // 50% of expected (4 hrs/day minimum threshold)
  if (totalHours > 0 && totalHours < expectedMinHours) {
    warnings.push(
      `Total period hours (${totalHours.toFixed(2)}) seem low for ${workdayCount} workdays. Ensure all time is accounted for.`
    );
  }

  return warnings;
}, [state.entries, state.periodStart]);
```

**A1b.** Pass the warnings to the `SubmitModal`. Update the `<SubmitModal>` invocation:

Find:

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
  completenessWarnings={completenessWarnings}
/>
```

---

### Phase B: Display Warnings in SubmitModal (B1)

#### B1. Modify `src/components/timesheet/SubmitModal.tsx` — Show completeness warnings

**B1a.** Update the Props type to accept `completenessWarnings`:

Find:

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
  completenessWarnings?: string[];
};
```

**B1b.** Update the component signature to destructure the new prop:

Find:

```typescript
export function SubmitModal({ opened, onClose, onConfirm, isSaving, periodLabel, flsaExempt, totalPeriodHours, uncompensatedHours }: Props) {
```

Replace with:

```typescript
export function SubmitModal({ opened, onClose, onConfirm, isSaving, periodLabel, flsaExempt, totalPeriodHours, uncompensatedHours, completenessWarnings }: Props) {
```

**B1c.** Add the warnings display in the modal body. Find the FLSA disclosure block (the `{flsaExempt && (` block). Add the completeness warnings AFTER the FLSA block and BEFORE the `<Textarea>`:

```tsx
{completenessWarnings && completenessWarnings.length > 0 && (
  <Alert icon={<IconAlertTriangle size={16} />} color="orange" variant="light">
    <Text size="sm" fw={600} mb={4}>
      Period Completeness Warnings ({completenessWarnings.length}):
    </Text>
    <Stack gap={2}>
      {completenessWarnings.map((warning, idx) => (
        <Text key={idx} size="sm">• {warning}</Text>
      ))}
    </Stack>
    <Text size="xs" c="dimmed" mt={8}>
      These warnings are recorded in the audit trail. You may still submit if the gaps are intentional.
    </Text>
  </Alert>
)}
```

**B1d.** Add `Stack` to the Mantine imports if not already present. Find the import line:

```typescript
import { Modal, Button, Group, Stack, Text, Textarea, Alert, Checkbox, Paper } from '@mantine/core';
```

`Stack` should already be imported. If not, add it.

**B1e.** Update the `handleSubmit` function to include warnings in the comment. This ensures the warnings are recorded in the `submittedComment` field for audit purposes.

Find:

```typescript
  async function handleSubmit() {
    if (!certified) return;
    await onConfirm(comment.trim() || undefined);
    setCertified(false);
    setComment('');
  }
```

Replace with:

```typescript
  async function handleSubmit() {
    if (!certified) return;

    // Append completeness warnings to the comment for audit trail
    let fullComment = comment.trim();
    if (completenessWarnings && completenessWarnings.length > 0) {
      const warningText = `[COMPLETENESS WARNINGS: ${completenessWarnings.join('; ')}]`;
      fullComment = fullComment ? `${fullComment}\n${warningText}` : warningText;
    }

    await onConfirm(fullComment || undefined);
    setCertified(false);
    setComment('');
  }
```

---

### Phase C: Server-Side Empty Period Block (C1)

#### C1. Modify `src/server/actions/periods.ts` — Add empty-period validation

**C1a.** Add the `timesheetEntries` import if not already present. Find the existing schema imports and ensure `timesheetEntries` is included:

```typescript
import { timesheetPeriods, users, timesheetEntries } from '@/db/schema';
```

Add `timesheetEntries` to the import if it's not already there.

Also add `sql` to the drizzle-orm import if not already present:

```typescript
import { eq, and, inArray, gte, lt, sql } from 'drizzle-orm';
```

**C1b.** In the `submitPeriod()` function, after the existing date validation (the `isSameOrAfter` check) and before the `existing` query, add an empty-period check:

Find:

```typescript
  // Server-side validation: cannot submit before the last day of the period
  const numDays = getNumDaysInPeriod(data.periodStart);
  const periodEndDate = dayjs(data.periodStart).add(numDays - 1, 'day');
  if (!dayjs().isSameOrAfter(periodEndDate, 'day')) {
    throw new Error(`Cannot submit before the last day of the pay period (${periodEndDate.format('MMM D, YYYY')}).`);
  }

  const existing = await db
```

Insert BETWEEN the date check and the `existing` query:

```typescript
  // Server-side validation: cannot submit a completely empty timesheet
  const periodEnd = dayjs(data.periodStart).add(numDays, 'day').toDate();
  const entryCount = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(timesheetEntries)
    .where(
      and(
        eq(timesheetEntries.userId, data.userId),
        gte(timesheetEntries.entryDate, data.periodStart),
        lt(timesheetEntries.entryDate, periodEnd),
      )
    );

  if (Number(entryCount[0]?.count ?? 0) === 0) {
    throw new Error('Cannot submit an empty timesheet. Please enter your hours before submitting.');
  }

```

---

## 4. Verification

### 4a. Build Check

```bash
npm run build
```

Must complete with **zero errors**.

### 4b. Warning Behavior Checks

| Check | Expected Result |
|---|---|
| **All workdays have hours** | No warnings in SubmitModal — clean submit |
| **3 weekdays with 0 hours** | Warning: "3 workdays with no hours recorded: Mon May 18, Tue May 19, Wed May 20" |
| **Day with 18 hours** | Warning: "18.00 hours recorded on Thu May 21 — please verify" |
| **Low total hours (20 hrs in period with 10 workdays)** | Warning: "Total period hours (20.00) seem low for 10 workdays" |
| **Submit with warnings** | Submission succeeds — warnings appended to `submittedComment` |
| **Empty timesheet submit** | 🔴 Blocked — "Cannot submit an empty timesheet" |
| **Weekend days with 0 hours** | No warning — weekends are expected to be zero |
| **Future days with 0 hours** | No warning — can't enter future hours, so missing future days are expected |

### 4c. Audit Trail Verification

| Check | Expected Result |
|---|---|
| **Submit with 2 warnings** | `submittedComment` contains `[COMPLETENESS WARNINGS: ...]` |
| **Submit with no warnings** | `submittedComment` contains only the employee's comment (or is empty) |
| **Supervisor sees warnings** | Warnings visible in the review drawer via `submittedComment` |

### 4d. DCAA Compliance Verification

| Requirement | How Verified |
|---|---|
| CAS 418 — Total Time | Warnings flag incomplete periods; employee acknowledges gaps via certification |
| FAR 31.201-1 — Daily Entry | Missing workdays are explicitly identified |
| Audit Trail | Warnings recorded in `submittedComment` — auditors can see acknowledgment |

### 4e. Common Errors to Watch For

| Error | Root Cause | Fix |
|---|---|---|
| `completenessWarnings` undefined in SubmitModal | Prop not passed from TimesheetToolbar | Verify the prop is included in the `<SubmitModal>` invocation |
| Warnings appear for future dates | Day comparison doesn't check for future | The code checks `isPastOrToday` — future weekdays are excluded |
| Warnings appear for weekends | Day-of-week check wrong | `dow >= 1 && dow <= 5` correctly identifies Mon-Fri |
| `submittedComment` too long | Many warnings concatenated | Warnings are concise — unlikely to exceed column limit |
| Empty period check counts old revisions | Query counts all entries including superseded | The count check is for existence of ANY entry, not just latest revision — this is correct (if any entry exists, the user has logged some time) |
| `Stack` not imported in SubmitModal | Missing Mantine import | Already imported in the existing file |
| `timesheetEntries` not imported in periods.ts | Missing schema import | Add to the import statement |
