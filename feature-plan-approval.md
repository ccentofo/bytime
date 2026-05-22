# Blueprint: Timesheet Submit & Approval Workflow

## 1. Architectural Overview & DCAA Impact

### The DCAA Requirement

Per CONTEXT.md: *"Approval Workflows: Digital certification is required for employees (submitting) and supervisors (reviewing/approving/rejecting)."*

This feature implements the complete lifecycle of a timesheet period:

```
DRAFT → SUBMITTED → APPROVED
                  → REJECTED → DRAFT (re-editable)
```

### Period Status Model

Each user has one `timesheetPeriod` record per semi-monthly pay period. This record tracks:

| Status | Editable? | Who Transitions? | Meaning |
|---|---|---|---|
| `draft` | ✅ Yes | — | Default. Employee is entering/editing hours. |
| `submitted` | ❌ No | Employee clicks "Submit" | Employee certifies hours are correct. Locked for editing. |
| `approved` | ❌ No | Supervisor clicks "Approve" | Supervisor certifies the timesheet. Permanently locked. |
| `rejected` | ✅ Yes (reverts to draft) | Supervisor clicks "Reject" | Returned to employee with comments. Employee must re-edit and re-submit. |

### DCAA Certification Statement

When an employee submits, they must acknowledge a certification statement. This is a DCAA requirement — the submission represents the employee's digital signature affirming the accuracy of their time entries.

### Supervisor Scope

A supervisor can see and approve/reject timesheets for employees who are assigned to CLINs under contracts the supervisor also has assignments to. For MVP, we simplify: **supervisors and admins can see ALL submitted timesheets**. Fine-grained supervisor-employee mapping is a future enhancement.

---

## 2. File Topology

```
Files to CREATE:
├── src/db/schema.ts                                     ← Add timesheetPeriods table (MODIFY)
├── src/server/actions/periods.ts                        ← Server Actions: submit, approve, reject, get period status
├── src/components/timesheet/SubmitModal.tsx              ← Employee certification modal
├── src/app/(app)/admin/approvals/
│   ├── page.tsx                                         ← Server Component: pending approvals list
│   └── ApprovalsClient.tsx                              ← Client Component: approval table + review drawer

Files to MODIFY:
├── src/db/schema.ts                                     ← Add timesheetPeriods table + periodStatusEnum
├── src/types/timesheet.ts                               ← Add periodStatus to TimesheetState + TimesheetPageData
├── src/components/timesheet/TimesheetToolbar.tsx         ← Add Submit button; disable Save when submitted
├── src/components/timesheet/TimesheetContext.tsx         ← Add periodStatus to state; add submitTimesheet action
├── src/components/timesheet/cells/HourCell.tsx           ← Disable editing when period is not draft
├── src/components/shell/AppNavbar.tsx                   ← Add "Approvals" link for supervisors/admins
├── src/app/(app)/timesheet/page.tsx                     ← Fetch period status; pass to client
├── src/server/actions/timesheet.ts                      ← Add getTimesheetForReview() for supervisor view

Files NOT TOUCHED (guardrail — DO NOT MODIFY):
├── src/components/timesheet/BiWeeklyTable.tsx            ← ❌ DO NOT MODIFY
├── src/components/timesheet/cells/ChargeCodeCell.tsx     ← ❌ DO NOT MODIFY
├── src/components/timesheet/cells/ColumnHeaderDate.tsx   ← ❌ DO NOT MODIFY
├── src/components/timesheet/cells/TotalHoursCell.tsx     ← ❌ DO NOT MODIFY
├── src/components/timesheet/DailyNoteModal.tsx           ← ❌ DO NOT MODIFY
├── src/components/timesheet/ReasonModal.tsx              ← ❌ DO NOT MODIFY
├── src/components/timesheet/PayPeriodSelector.tsx        ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/contracts/*                       ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/assignments/*                     ← ❌ DO NOT MODIFY
├── src/server/actions/contracts.ts                       ← ❌ DO NOT MODIFY
├── src/server/actions/clins.ts                           ← ❌ DO NOT MODIFY
├── src/server/actions/assignments.ts                     ← ❌ DO NOT MODIFY
├── src/server/actions/users.ts                           ← ❌ DO NOT MODIFY
├── src/auth.ts                                           ← ❌ DO NOT MODIFY
├── src/middleware.ts                                     ← ❌ DO NOT MODIFY
```

---

## 3. Step-by-Step Execution Plan

> **⚠️ CRITICAL GUARDRAILS FOR THE EXECUTION AGENT:**
> - **DO NOT** search, grep, or read files inside `node_modules/`, `.next/`, or `dist/`.
> - **DO NOT** read documentation files or search for library docs.
> - **DO NOT** modify any files listed in the "NOT TOUCHED" section above.
> - Use **Mantine v9** imports only (`@mantine/core`, `@mantine/hooks`).
> - Use **Mantine React Table v2** (`mantine-react-table`) for the approvals table.
> - Use `@tabler/icons-react` for all icons.
> - Use `bcryptjs` (NOT `bcrypt`) if any password operations are needed.
> - **DCAA Rule:** Never UPDATE or DELETE timesheet entry rows. Period status changes are separate records.
> - Follow the step order exactly. Each step builds on the previous one.

---

### Step 0: Add Timesheet Periods Table to Schema

**0a.** Modify `src/db/schema.ts` — add a new enum and table AFTER the existing `timesheetEntries` table:

Add this new enum after the existing enums at the top of the file:

```typescript
export const periodStatusEnum = pgEnum('period_status', ['draft', 'submitted', 'approved', 'rejected']);
```

Then add this new table after `timesheetEntries`:

```typescript
// ---------------------------------------------------------------------------
// Timesheet Periods (tracks period lifecycle: draft → submitted → approved/rejected)
// ---------------------------------------------------------------------------

export const timesheetPeriods = pgTable('timesheet_periods', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id),
  periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
  status: periodStatusEnum('status').notNull().default('draft'),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  submittedComment: text('submitted_comment'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  reviewedBy: uuid('reviewed_by').references(() => users.id),
  reviewComment: text('review_comment'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('user_period_unique_idx').on(table.userId, table.periodStart),
]);
```

**0b.** Push the schema:

```bash
export DATABASE_URL=postgresql://bytime:bytime_dev@localhost:5432/bytime
npx drizzle-kit push
```

---

### Step 1: Create Period Server Actions

**1a.** Create `src/server/actions/periods.ts`:

```typescript
'use server';

import { db } from '@/db';
import { timesheetPeriods, users } from '@/db/schema';
import { eq, and } from 'drizzle-orm';

export type PeriodStatus = 'draft' | 'submitted' | 'approved' | 'rejected';

export interface PeriodInfo {
  id: string | null;
  status: PeriodStatus;
  submittedAt: Date | null;
  reviewedAt: Date | null;
  reviewedBy: string | null;
  reviewComment: string | null;
}

/**
 * Get the period status for a specific user and period start date.
 * Returns draft if no record exists yet.
 */
export async function getPeriodStatus(userId: string, periodStart: Date): Promise<PeriodInfo> {
  const rows = await db
    .select()
    .from(timesheetPeriods)
    .where(
      and(
        eq(timesheetPeriods.userId, userId),
        eq(timesheetPeriods.periodStart, periodStart),
      )
    );

  if (rows.length === 0) {
    return {
      id: null,
      status: 'draft',
      submittedAt: null,
      reviewedAt: null,
      reviewedBy: null,
      reviewComment: null,
    };
  }

  const row = rows[0];
  return {
    id: row.id,
    status: row.status,
    submittedAt: row.submittedAt,
    reviewedAt: row.reviewedAt,
    reviewedBy: row.reviewedBy,
    reviewComment: row.reviewComment,
  };
}

/**
 * Submit a timesheet period (employee certification).
 * Creates the period record if it doesn't exist, or updates status to 'submitted'.
 */
export async function submitPeriod(data: {
  userId: string;
  periodStart: Date;
  comment?: string;
}): Promise<PeriodInfo> {
  const existing = await db
    .select()
    .from(timesheetPeriods)
    .where(
      and(
        eq(timesheetPeriods.userId, data.userId),
        eq(timesheetPeriods.periodStart, data.periodStart),
      )
    );

  if (existing.length === 0) {
    // Create new period record
    const rows = await db.insert(timesheetPeriods).values({
      userId: data.userId,
      periodStart: data.periodStart,
      status: 'submitted',
      submittedAt: new Date(),
      submittedComment: data.comment,
    }).returning();

    return {
      id: rows[0].id,
      status: 'submitted',
      submittedAt: rows[0].submittedAt,
      reviewedAt: null,
      reviewedBy: null,
      reviewComment: null,
    };
  }

  // Update existing record
  const row = existing[0];
  if (row.status !== 'draft' && row.status !== 'rejected') {
    throw new Error(`Cannot submit period with status "${row.status}". Only draft or rejected periods can be submitted.`);
  }

  const rows = await db.update(timesheetPeriods)
    .set({
      status: 'submitted',
      submittedAt: new Date(),
      submittedComment: data.comment,
      reviewedAt: null,
      reviewedBy: null,
      reviewComment: null,
      updatedAt: new Date(),
    })
    .where(eq(timesheetPeriods.id, row.id))
    .returning();

  return {
    id: rows[0].id,
    status: 'submitted',
    submittedAt: rows[0].submittedAt,
    reviewedAt: null,
    reviewedBy: null,
    reviewComment: null,
  };
}

/**
 * Approve a timesheet period (supervisor action).
 */
export async function approvePeriod(data: {
  periodId: string;
  reviewedBy: string;
  comment?: string;
}): Promise<void> {
  const existing = await db
    .select()
    .from(timesheetPeriods)
    .where(eq(timesheetPeriods.id, data.periodId));

  if (existing.length === 0) throw new Error('Period not found');
  if (existing[0].status !== 'submitted') {
    throw new Error(`Cannot approve period with status "${existing[0].status}". Only submitted periods can be approved.`);
  }

  await db.update(timesheetPeriods)
    .set({
      status: 'approved',
      reviewedAt: new Date(),
      reviewedBy: data.reviewedBy,
      reviewComment: data.comment ?? null,
      updatedAt: new Date(),
    })
    .where(eq(timesheetPeriods.id, data.periodId));
}

/**
 * Reject a timesheet period (supervisor action).
 * Returns the period to 'draft' status so the employee can re-edit.
 */
export async function rejectPeriod(data: {
  periodId: string;
  reviewedBy: string;
  comment: string; // Required for rejections
}): Promise<void> {
  const existing = await db
    .select()
    .from(timesheetPeriods)
    .where(eq(timesheetPeriods.id, data.periodId));

  if (existing.length === 0) throw new Error('Period not found');
  if (existing[0].status !== 'submitted') {
    throw new Error(`Cannot reject period with status "${existing[0].status}". Only submitted periods can be rejected.`);
  }

  await db.update(timesheetPeriods)
    .set({
      status: 'rejected',
      reviewedAt: new Date(),
      reviewedBy: data.reviewedBy,
      reviewComment: data.comment,
      updatedAt: new Date(),
    })
    .where(eq(timesheetPeriods.id, data.periodId));
}

/**
 * Get all submitted timesheets pending review (for supervisors/admins).
 */
export async function getPendingApprovals(): Promise<Array<{
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  periodStart: Date;
  status: PeriodStatus;
  submittedAt: Date | null;
}>> {
  const rows = await db
    .select({
      id: timesheetPeriods.id,
      userId: timesheetPeriods.userId,
      userName: users.fullName,
      userEmail: users.email,
      periodStart: timesheetPeriods.periodStart,
      status: timesheetPeriods.status,
      submittedAt: timesheetPeriods.submittedAt,
    })
    .from(timesheetPeriods)
    .innerJoin(users, eq(timesheetPeriods.userId, users.id))
    .where(eq(timesheetPeriods.status, 'submitted'))
    .orderBy(timesheetPeriods.submittedAt);

  return rows;
}

/**
 * Get all timesheet periods for a supervisor to review (all statuses).
 */
export async function getAllPeriods(): Promise<Array<{
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  periodStart: Date;
  status: PeriodStatus;
  submittedAt: Date | null;
  reviewedAt: Date | null;
}>> {
  const rows = await db
    .select({
      id: timesheetPeriods.id,
      userId: timesheetPeriods.userId,
      userName: users.fullName,
      userEmail: users.email,
      periodStart: timesheetPeriods.periodStart,
      status: timesheetPeriods.status,
      submittedAt: timesheetPeriods.submittedAt,
      reviewedAt: timesheetPeriods.reviewedAt,
    })
    .from(timesheetPeriods)
    .innerJoin(users, eq(timesheetPeriods.userId, users.id))
    .orderBy(timesheetPeriods.submittedAt);

  return rows;
}
```

---

### Step 2: Add Review Data Server Action

**2a.** Modify `src/server/actions/timesheet.ts` — add a function to get a user's timesheet for supervisor review. Add this at the END of the file (do not modify existing functions):

```typescript
/**
 * Get a read-only view of a user's timesheet for supervisor review.
 * Returns charge codes and entries for the specified user and period.
 */
export async function getTimesheetForReview(
  userId: string,
  periodStart: Date
): Promise<{ chargeCodes: ChargeCode[]; entries: TimesheetEntry[] }> {
  const chargeCodes = await getChargeCodesForUser(userId);
  const entries = await getTimesheetEntries(userId, periodStart, chargeCodes);
  return { chargeCodes, entries };
}
```

---

### Step 3: Update Types

**3a.** Modify `src/types/timesheet.ts` — add period status to state and page data:

Add the `PeriodStatus` type and update `TimesheetState`, `TimesheetAction`, and `TimesheetPageData`. Add/modify these (keep all existing types unchanged):

Add this type near the top (after the existing interfaces):

```typescript
export type PeriodStatus = 'draft' | 'submitted' | 'approved' | 'rejected';
```

Add `periodStatus` to `TimesheetState`:

```typescript
periodStatus: PeriodStatus; // current period's approval status
```

Add this new action to the `TimesheetAction` union:

```typescript
| { type: 'SET_PERIOD_STATUS'; status: PeriodStatus }
```

Add `periodStatus` to `TimesheetPageData`:

```typescript
periodStatus?: PeriodStatus; // optional: period status from server
```

---

### Step 4: Update TimesheetContext

**4a.** Modify `src/components/timesheet/TimesheetContext.tsx`:

Add these changes (do NOT replace the entire file — only add/modify the specific parts):

**4a-i.** Add `periodStatus` to the `initialState` in the `TimesheetProvider`:

```typescript
periodStatus: initialData.periodStatus ?? 'draft',
```

**4a-ii.** Add the `SET_PERIOD_STATUS` case to the reducer:

```typescript
case 'SET_PERIOD_STATUS': {
  return { ...state, periodStatus: action.status };
}
```

**4a-iii.** In the `NAVIGATE_PERIOD` case, reset the periodStatus:

Add `periodStatus: 'draft',` to the return object (periods default to draft until fetched).

**4a-iv.** In the `SET_PERIOD_DATA` case, if the action includes periodStatus, set it. Update the `SET_PERIOD_DATA` action type in the reducer to also accept an optional `periodStatus`:

Update the action type (in `src/types/timesheet.ts`):

```typescript
| { type: 'SET_PERIOD_DATA'; periodStart: Date; entries: TimesheetEntry[]; revisions: Record<string, number>; periodStatus?: PeriodStatus }
```

And in the reducer:

```typescript
case 'SET_PERIOD_DATA': {
  return {
    ...state,
    periodStart: action.periodStart,
    entries: action.entries,
    savedEntries: action.entries.map((e) => ({ ...e, hours: [...e.hours] })),
    savedCellRevisions: action.revisions,
    periodStatus: action.periodStatus ?? state.periodStatus,
  };
}
```

**4a-v.** Add `submitTimesheet` to the context value and provider:

Add to `TimesheetContextValue`:

```typescript
submitTimesheet: (comment?: string) => Promise<void>;
```

Add the implementation in the provider (import `submitPeriod` and `getPeriodStatus` from `@/server/actions/periods`):

```typescript
const submitTimesheet = useCallback(
  async (comment?: string) => {
    try {
      dispatch({ type: 'SET_SAVING', isSaving: true });
      await submitPeriod({
        userId: state.userId,
        periodStart: state.periodStart,
        comment,
      });
      dispatch({ type: 'SET_PERIOD_STATUS', status: 'submitted' });
    } catch (error) {
      console.error('Failed to submit timesheet:', error);
      throw error;
    } finally {
      dispatch({ type: 'SET_SAVING', isSaving: false });
    }
  },
  [state.userId, state.periodStart]
);
```

Add `submitTimesheet` to the Provider's value.

**4a-vi.** Update `loadPeriod` to also fetch the period status. After fetching entries and revisions, also fetch period status:

```typescript
const periodInfo = await getPeriodStatus(state.userId, newPeriodStart);
dispatch({
  type: 'SET_PERIOD_DATA',
  periodStart: newPeriodStart,
  entries,
  revisions,
  periodStatus: periodInfo.status,
});
```

---

### Step 5: Create the Submit Modal

**5a.** Create `src/components/timesheet/SubmitModal.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { Modal, Button, Group, Stack, Text, Textarea, Alert, Checkbox } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';

type Props = {
  opened: boolean;
  onClose: () => void;
  onConfirm: (comment?: string) => Promise<void>;
  isSaving: boolean;
  periodLabel: string;
};

export function SubmitModal({ opened, onClose, onConfirm, isSaving, periodLabel }: Props) {
  const [certified, setCertified] = useState(false);
  const [comment, setComment] = useState('');

  function handleClose() {
    if (!isSaving) {
      setCertified(false);
      setComment('');
      onClose();
    }
  }

  async function handleSubmit() {
    if (!certified) return;
    await onConfirm(comment.trim() || undefined);
    setCertified(false);
    setComment('');
  }

  return (
    <Modal
      opened={opened}
      onClose={handleClose}
      title="Submit Timesheet for Approval"
      size="md"
      centered
      closeOnClickOutside={false}
      closeOnEscape={!isSaving}
    >
      <Stack>
        <Alert icon={<IconAlertTriangle size={16} />} color="yellow" variant="light">
          <Text size="sm" fw={600}>
            You are submitting your timesheet for {periodLabel}.
          </Text>
          <Text size="sm" mt={4}>
            Once submitted, you will not be able to edit this timesheet unless your supervisor returns it for corrections.
          </Text>
        </Alert>

        <Textarea
          label="Comments (optional)"
          placeholder="Any notes for your supervisor..."
          minRows={2}
          value={comment}
          onChange={(e) => setComment(e.currentTarget.value)}
        />

        <Checkbox
          label="I certify that the hours recorded on this timesheet are a true and accurate representation of the time I worked during this pay period."
          checked={certified}
          onChange={(e) => setCertified(e.currentTarget.checked)}
          styles={{ label: { fontWeight: 600 } }}
        />

        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={handleClose} disabled={isSaving}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!certified}
            loading={isSaving}
            color="green"
          >
            Submit Timesheet
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
```

**Key details:**
- Employee must check a certification checkbox before submitting
- The certification text mirrors DCAA language about accuracy
- Optional comment field for notes to the supervisor
- Cannot dismiss while submitting

---

### Step 6: Update TimesheetToolbar

**6a.** Modify `src/components/timesheet/TimesheetToolbar.tsx`:

Replace the entire file with:

```tsx
'use client';

import { Button, Group, Badge, Text, Alert } from '@mantine/core';
import { IconDeviceFloppy, IconArrowBack, IconSend, IconAlertCircle } from '@tabler/icons-react';
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
  const [saveError, setSaveError] = useState<string | null>(null);

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
      setSaveError(null);
      await saveAll();
    } catch (error) {
      setSaveError('Failed to save. Please try again.');
    }
  }

  async function handleReasonConfirm(reasonCode: string, comment: string) {
    try {
      setSaveError(null);
      await saveAll(reasonCode, comment);
      setReasonModalOpen(false);
    } catch (error) {
      setSaveError('Failed to save. Please try again.');
    }
  }

  function handleDiscard() {
    discardChanges();
    setSaveError(null);
  }

  async function handleSubmitConfirm(comment?: string) {
    try {
      setSaveError(null);
      await submitTimesheet(comment);
      setSubmitModalOpen(false);
    } catch (error) {
      setSaveError('Failed to submit. Please try again.');
    }
  }

  return (
    <>
      {/* Rejection notice */}
      {periodStatus === 'rejected' && state.periodStatus === 'rejected' && (
        <Alert icon={<IconAlertCircle size={16} />} color="red" variant="light" mb="sm">
          <Text size="sm" fw={600}>
            This timesheet was returned for corrections. Please review the supervisor's comments, make necessary changes, and re-submit.
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
          {saveError && (
            <Text c="red" size="sm">
              {saveError}
            </Text>
          )}
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

**Key changes:**
- Added period status badge (Draft/Submitted/Approved/Rejected)
- Save/Discard buttons only show when period is editable (draft or rejected)
- Submit button appears when period is editable AND there are no unsaved changes AND at least one hour entry exists
- Rejection alert banner when period is in rejected status
- Submit button opens the SubmitModal

---

### Step 7: Update HourCell for Read-Only Mode

**7a.** Modify `src/components/timesheet/cells/HourCell.tsx`:

Add a check at the beginning of the component to disable editing when the period is not editable:

After the existing `useTimesheet()` call, add:

```typescript
const isEditable = state.periodStatus === 'draft' || state.periodStatus === 'rejected';
```

Then modify `handleClick` to bail out if not editable:

```typescript
const handleClick = () => {
  if (!isEditable) return; // Period is locked (submitted/approved)
  setLocalValue(value);
  setIsEditing(true);
};
```

Also update the cursor style on the cell div based on editability. Add to the `style` prop of the outer `div`:

```typescript
cursor: isEditable ? 'pointer' : 'default',
opacity: isEditable ? 1 : undefined,
```

---

### Step 8: Update Timesheet Page to Pass Period Status

**8a.** Modify `src/app/(app)/timesheet/page.tsx`:

Add the period status fetch. Import `getPeriodStatus` from `@/server/actions/periods` and include it in the parallel data fetch:

```typescript
import { getPeriodStatus } from '@/server/actions/periods';
```

Update the data fetching to include period status:

```typescript
const [entries, revisions, periodInfo] = await Promise.all([
  getTimesheetEntries(userId, periodStart, chargeCodes),
  getRevisionMap(userId, periodStart, numDays),
  getPeriodStatus(userId, periodStart),
]);
```

And add `periodStatus` to the page data:

```typescript
const pageData: TimesheetPageData = {
  userId,
  chargeCodes,
  entries,
  periodStart,
  revisions,
  periodStatus: periodInfo.status,
};
```

---

### Step 9: Add Approvals Link to Navbar

**9a.** Modify `src/components/shell/AppNavbar.tsx`:

Add a new NavLink for the Approvals page in the ADMINISTRATION section. Import `IconChecklist` from `@tabler/icons-react`.

Add this NavLink after the "User Assignments" NavLink, inside the `{isAdmin && (...)}` block:

```tsx
<NavLink
  label="Timesheet Approvals"
  href="/admin/approvals"
  leftSection={<IconChecklist size={18} />}
  active={pathname === '/admin/approvals'}
/>
```

---

### Step 10: Create the Approvals Page

**10a.** Create `src/app/(app)/admin/approvals/page.tsx`:

```tsx
import { getAllPeriods } from '@/server/actions/periods';
import { ApprovalsClient } from './ApprovalsClient';

export const dynamic = 'force-dynamic';

export default async function ApprovalsPage() {
  const periods = await getAllPeriods();
  return <ApprovalsClient initialPeriods={periods} />;
}
```

**10b.** Create `src/app/(app)/admin/approvals/ApprovalsClient.tsx`:

```tsx
'use client';

import { useState, useTransition } from 'react';
import {
  Title,
  Badge,
  Button,
  Drawer,
  Stack,
  Text,
  Textarea,
  Group,
  Paper,
  Table,
  Alert,
} from '@mantine/core';
import { IconCheck, IconX, IconEye, IconAlertCircle } from '@tabler/icons-react';
import { MantineReactTable, useMantineReactTable, type MRT_ColumnDef } from 'mantine-react-table';
import dayjs from 'dayjs';
import { approvePeriod, rejectPeriod, getAllPeriods } from '@/server/actions/periods';
import { getTimesheetForReview } from '@/server/actions/timesheet';
import { getNumDaysInPeriod } from '@/lib/date-utils';
import type { ChargeCode, TimesheetEntry } from '@/types/timesheet';

type Period = {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  periodStart: Date;
  status: string;
  submittedAt: Date | null;
  reviewedAt: Date | null;
};

type Props = {
  initialPeriods: Period[];
};

const STATUS_COLORS: Record<string, string> = {
  draft: 'yellow',
  submitted: 'blue',
  approved: 'green',
  rejected: 'red',
};

export function ApprovalsClient({ initialPeriods }: Props) {
  const [periods, setPeriods] = useState(initialPeriods);
  const [isPending, startTransition] = useTransition();

  // Review drawer state
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedPeriod, setSelectedPeriod] = useState<Period | null>(null);
  const [reviewData, setReviewData] = useState<{
    chargeCodes: ChargeCode[];
    entries: TimesheetEntry[];
  } | null>(null);
  const [rejectComment, setRejectComment] = useState('');
  const [approveComment, setApproveComment] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);

  // Get the current user ID from session (passed via context or fetched)
  // For now, we'll pass it through the approve/reject actions

  function openReview(period: Period) {
    setSelectedPeriod(period);
    setDrawerOpen(true);
    setRejectComment('');
    setApproveComment('');
    setActionError(null);

    startTransition(async () => {
      const data = await getTimesheetForReview(period.userId, period.periodStart);
      setReviewData(data);
    });
  }

  function handleApprove() {
    if (!selectedPeriod) return;
    startTransition(async () => {
      try {
        setActionError(null);
        await approvePeriod({
          periodId: selectedPeriod.id,
          reviewedBy: '', // Will use session in production
          comment: approveComment.trim() || undefined,
        });
        const refreshed = await getAllPeriods();
        setPeriods(refreshed);
        setDrawerOpen(false);
      } catch (error) {
        setActionError(String(error));
      }
    });
  }

  function handleReject() {
    if (!selectedPeriod || !rejectComment.trim()) return;
    startTransition(async () => {
      try {
        setActionError(null);
        await rejectPeriod({
          periodId: selectedPeriod.id,
          reviewedBy: '', // Will use session in production
          comment: rejectComment.trim(),
        });
        const refreshed = await getAllPeriods();
        setPeriods(refreshed);
        setDrawerOpen(false);
      } catch (error) {
        setActionError(String(error));
      }
    });
  }

  const columns: MRT_ColumnDef<Period>[] = [
    {
      accessorKey: 'userName',
      header: 'Employee',
      size: 180,
    },
    {
      accessorKey: 'periodStart',
      header: 'Pay Period',
      Cell: ({ cell }) => {
        const start = dayjs(cell.getValue<Date>());
        const numDays = getNumDaysInPeriod(start.toDate());
        const end = start.add(numDays - 1, 'day');
        return `${start.format('MMM D')} – ${end.format('MMM D, YYYY')}`;
      },
      size: 200,
    },
    {
      accessorKey: 'status',
      header: 'Status',
      Cell: ({ cell }) => {
        const status = cell.getValue<string>();
        return (
          <Badge color={STATUS_COLORS[status] ?? 'gray'}>
            {status.charAt(0).toUpperCase() + status.slice(1)}
          </Badge>
        );
      },
      size: 130,
    },
    {
      accessorKey: 'submittedAt',
      header: 'Submitted',
      Cell: ({ cell }) => {
        const val = cell.getValue<Date | null>();
        return val ? dayjs(val).format('MMM D, YYYY h:mm A') : '—';
      },
      size: 180,
    },
  ];

  const table = useMantineReactTable({
    columns,
    data: periods,
    enableRowActions: true,
    positionActionsColumn: 'last',
    renderRowActions: ({ row }) => (
      <Button
        size="xs"
        variant="subtle"
        leftSection={<IconEye size={14} />}
        onClick={() => openReview(row.original)}
        disabled={row.original.status === 'draft'}
      >
        Review
      </Button>
    ),
  });

  // Build review table content
  let reviewContent = null;
  if (reviewData && selectedPeriod) {
    const numDays = getNumDaysInPeriod(selectedPeriod.periodStart);
    const start = dayjs(selectedPeriod.periodStart);

    reviewContent = (
      <Stack mt="md">
        <Text fw={600} size="sm">Time Entries:</Text>
        <Table striped withTableBorder>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Charge Code</Table.Th>
              {Array.from({ length: numDays }, (_, i) => (
                <Table.Th key={i} style={{ textAlign: 'center', fontSize: 11 }}>
                  {start.add(i, 'day').format('M/D')}
                </Table.Th>
              ))}
              <Table.Th style={{ textAlign: 'center' }}>Total</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {reviewData.chargeCodes.map((cc) => {
              const entry = reviewData.entries.find((e) => e.chargeCodeId === cc.id);
              const hours = entry?.hours ?? [];
              const total = hours.reduce((a, b) => a + b, 0);
              return (
                <Table.Tr key={cc.id}>
                  <Table.Td>{cc.clin} — {cc.projectName}</Table.Td>
                  {Array.from({ length: numDays }, (_, i) => (
                    <Table.Td key={i} style={{ textAlign: 'center' }}>
                      {(hours[i] ?? 0) === 0 ? '—' : (hours[i] ?? 0).toFixed(2)}
                    </Table.Td>
                  ))}
                  <Table.Td style={{ textAlign: 'center', fontWeight: 700 }}>
                    {total.toFixed(2)}
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </Stack>
    );
  }

  return (
    <>
      <Title order={2} mb="md">Timesheet Approvals</Title>
      <MantineReactTable table={table} />

      <Drawer
        opened={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        position="right"
        size="xl"
        title={
          selectedPeriod
            ? `Review — ${selectedPeriod.userName}`
            : 'Review Timesheet'
        }
      >
        <Stack>
          {selectedPeriod && (
            <Paper withBorder p="sm">
              <Group>
                <Text size="sm"><strong>Employee:</strong> {selectedPeriod.userName}</Text>
                <Text size="sm"><strong>Email:</strong> {selectedPeriod.userEmail}</Text>
                <Badge color={STATUS_COLORS[selectedPeriod.status] ?? 'gray'}>
                  {selectedPeriod.status}
                </Badge>
              </Group>
            </Paper>
          )}

          {reviewData === null && isPending && (
            <Text c="dimmed" size="sm">Loading timesheet data...</Text>
          )}

          {reviewContent}

          {actionError && (
            <Alert icon={<IconAlertCircle size={16} />} color="red" variant="light">
              {actionError}
            </Alert>
          )}

          {selectedPeriod?.status === 'submitted' && (
            <>
              <Textarea
                label="Approval Comment (optional)"
                placeholder="Any feedback for the employee..."
                value={approveComment}
                onChange={(e) => setApproveComment(e.currentTarget.value)}
              />

              <Textarea
                label="Rejection Comment (required if rejecting)"
                placeholder="Explain what needs to be corrected..."
                value={rejectComment}
                onChange={(e) => setRejectComment(e.currentTarget.value)}
              />

              <Group justify="flex-end" mt="md">
                <Button
                  color="red"
                  variant="light"
                  leftSection={<IconX size={16} />}
                  onClick={handleReject}
                  disabled={!rejectComment.trim()}
                  loading={isPending}
                >
                  Reject
                </Button>
                <Button
                  color="green"
                  leftSection={<IconCheck size={16} />}
                  onClick={handleApprove}
                  loading={isPending}
                >
                  Approve
                </Button>
              </Group>
            </>
          )}
        </Stack>
      </Drawer>
    </>
  );
}
```

**Key details:**
- Mantine React Table lists all timesheet periods with status badges
- "Review" button opens a Drawer with a read-only summary table of the employee's hours
- Supervisors can Approve (optional comment) or Reject (required comment)
- After action, data refreshes automatically
- The review table shows all charge codes with daily hours and totals

---

## 4. Verification

### 4a. Schema Push

```bash
export DATABASE_URL=postgresql://bytime:bytime_dev@localhost:5432/bytime
npx drizzle-kit push
```

Verify the `timesheet_periods` table exists:

```bash
psql postgresql://bytime:bytime_dev@localhost:5432/bytime -c "\d timesheet_periods"
```

### 4b. Build Check

```bash
npm run build
```

Must complete with **zero errors**.

### 4c. Dev Server — Employee Flow

Login as `jane.smith@bytime.dev` (employee):

| Check | Expected Result |
|---|---|
| **Timesheet loads** | Status badge shows "Draft" |
| **Enter hours and Save** | Hours saved; dirty indicators clear |
| **Submit button** | Enabled (no unsaved changes, hours > 0) |
| **Click Submit** | Certification modal opens |
| **Uncheck certification** | Submit button is disabled |
| **Check certification and click Submit** | Period status changes to "Submitted — Pending Review" |
| **Try editing a cell** | Cell is NOT editable (locked) |
| **Save/Discard/Submit buttons** | All hidden (period is submitted) |
| **Navigate to different period** | New period is in "Draft" status (editable) |

### 4d. Dev Server — Supervisor Flow

Login as `sarah.wilson@bytime.dev` (supervisor) or `admin@bytime.dev` (admin):

| Check | Expected Result |
|---|---|
| **Navbar** | Shows "Timesheet Approvals" link under ADMINISTRATION |
| **Visit /admin/approvals** | Table shows submitted periods |
| **Click Review** | Drawer opens with employee name + read-only hours table |
| **Click Approve** | Period status changes to "Approved"; row updates in table |
| **Submit another timesheet as employee** | Appears in approvals list |
| **Click Reject (without comment)** | Reject button is disabled |
| **Type rejection comment and click Reject** | Period status changes to "Rejected" |
| **Login as employee again** | Rejected period shows red alert banner + "Rejected" badge; cells are editable again |
| **Re-edit, save, and re-submit** | Full cycle works; period goes back to "Submitted" |

### 4e. Guardrail Verification

```bash
git diff --name-only
```

Must **NOT** include:
- `src/components/timesheet/BiWeeklyTable.tsx`
- `src/components/timesheet/cells/ChargeCodeCell.tsx`
- `src/components/timesheet/cells/ColumnHeaderDate.tsx`
- `src/components/timesheet/cells/TotalHoursCell.tsx`
- `src/components/timesheet/DailyNoteModal.tsx`
- `src/components/timesheet/ReasonModal.tsx`
- `src/components/timesheet/PayPeriodSelector.tsx`
- `src/app/(app)/admin/contracts/*`
- `src/app/(app)/admin/assignments/*`
- `src/server/actions/contracts.ts`
- `src/server/actions/clins.ts`
- `src/server/actions/assignments.ts`
- `src/server/actions/users.ts`
- `src/auth.ts`
- `src/middleware.ts`

### 4f. Common Errors to Watch For

| Error | Root Cause | Fix |
|---|---|---|
| `relation "timesheet_periods" does not exist` | Schema not pushed | Run `npx drizzle-kit push` |
| `periodStatusEnum is not defined` | Missing enum in schema | Add `periodStatusEnum` before the table definition |
| `submitTimesheet is not a function` | Context not updated | Verify `TimesheetContextValue` includes `submitTimesheet` |
| `Property 'periodStatus' does not exist` | Types not updated | Verify `TimesheetState` includes `periodStatus` |
| `Cannot approve period with status "draft"` | Trying to approve unsubmitted period | Only submitted periods can be approved |
| Cells still editable after submit | `isEditable` check missing in HourCell | Verify `state.periodStatus` check |
| Submit button enabled with unsaved changes | `canSubmit` logic wrong | `canSubmit = isEditable && dirtyCount === 0 && hasHours` |
| `getTimesheetForReview is not exported` | Server action not added | Add function to `src/server/actions/timesheet.ts` |
| `IconChecklist is not exported` | Wrong icon name | Use `IconChecklist` from `@tabler/icons-react` |
