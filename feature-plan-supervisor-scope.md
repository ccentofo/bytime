# Blueprint: Supervisor Scope Mapping — Contract-Based Approval Chains

## 1. Architectural Overview & DCAA Impact

### The Problem

The current approval workflow (from `feature-plan-approval.md`) states: *"For MVP, we simplify: supervisors and admins can see ALL submitted timesheets."* This means every supervisor can approve/reject every employee's timesheet, regardless of whether they share any contract assignments.

In production, this creates several issues:
1. **Information Leakage** — Supervisors see time charges for contracts they have no involvement with
2. **Unauthorized Approvals** — A supervisor on Contract A could approve timesheets with charges to Contract B, which they have no authority over
3. **DCAA Audit Risk** — Auditors expect the approving supervisor to have knowledge of the work being certified

### The Solution: Contract-Based Supervisor Scope

A supervisor should only be able to see and approve timesheets for employees who share **at least one active CLIN assignment** with them. The logic:

```
Supervisor S can review Employee E's timesheet if and only if:
  EXISTS a CLIN C where:
    - user_assignments has (userId=S, clinId=C, isActive=true)
    - user_assignments has (userId=E, clinId=C, isActive=true)
```

This ensures supervisors only approve time for employees working on contracts they're responsible for.

### Design Decisions

1. **No new database tables** — The existing `user_assignments` table already captures who is assigned to which CLINs. The scope is derived from overlapping assignments.
2. **Admins bypass scope** — Users with `role='admin'` can see ALL timesheets (for system administration). Only `role='supervisor'` is scope-limited.
3. **Full timesheet visibility** — If a supervisor shares even one CLIN with an employee, they can see the employee's entire timesheet (all CLINs). This avoids partial-timesheet approval complexity.
4. **Graceful degradation** — If a supervisor has zero CLIN assignments, they see zero pending timesheets (with a helpful message).

### DCAA Compliance Requirements Addressed

| DCAA / FAR Requirement | How Supervisor Scope Satisfies It |
|---|---|
| **FAR 31.201-1 — Allowable Costs** | Ensures the person certifying hours has direct knowledge of the work performed |
| **CAS 418 — Cost Accounting** | Supervisors only approve charges they can validate, preventing erroneous cost allocations |
| **DCAA Audit Trail** | The `reviewed_by` field already records who approved; scope ensures this person is an authorized reviewer |
| **Separation of Duties** | Prevents cross-contract approval that could mask mischarging |

---

## 2. File Topology

```
Files to CREATE:
├── src/server/actions/supervisor-scope.ts           ← Server Actions: scope queries

Files to MODIFY:
├── src/server/actions/periods.ts                    ← Update getPendingApprovals/getAllPeriods to accept scope
├── src/app/(app)/admin/approvals/page.tsx            ← Pass scoped employee IDs
├── src/app/(app)/admin/approvals/ApprovalsClient.tsx ← Show scope info, handle empty state

Files NOT TOUCHED (guardrail — DO NOT MODIFY):
├── src/db/schema.ts                                 ← ❌ DO NOT MODIFY
├── src/auth.ts                                      ← ❌ DO NOT MODIFY
├── src/middleware.ts                                ← ❌ DO NOT MODIFY
├── src/server/actions/timesheet.ts                  ← ❌ DO NOT MODIFY
├── src/server/actions/contracts.ts                  ← ❌ DO NOT MODIFY
├── src/server/actions/clins.ts                      ← ❌ DO NOT MODIFY
├── src/server/actions/assignments.ts                ← ❌ DO NOT MODIFY
├── src/server/actions/users.ts                      ← ❌ DO NOT MODIFY
├── src/server/actions/dashboard.ts                  ← ❌ DO NOT MODIFY
├── src/server/actions/audit.ts                      ← ❌ DO NOT MODIFY
├── src/components/timesheet/*                       ← ❌ DO NOT MODIFY
├── src/components/shell/*                           ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/contracts/*                   ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/assignments/*                 ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/users/*                       ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/audit-trail/*                 ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/dashboard/*                   ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/labor-categories/*             ← ❌ DO NOT MODIFY
```

---

## 3. Step-by-Step Execution Plan

> **⚠️ CRITICAL GUARDRAILS FOR THE EXECUTION AGENT:**
> - **DO NOT** search, grep, or read files inside `node_modules/`, `.next/`, or `dist/`.
> - **DO NOT** modify any files listed in the "DO NOT MODIFY" section above.
> - Use **Mantine v9** imports only (`@mantine/core`, `@mantine/hooks`, `@mantine/notifications`).
> - Use **Drizzle ORM** for all database queries.
> - Follow the step order exactly. Each step builds on the previous one.
> - **After completing each phase, run `npm run build` to verify zero errors.**
> - **Key rule:** Admin users (`role='admin'`) bypass all scope restrictions and see everything.

---

### Phase A: Supervisor Scope Query (A1)

#### A1. Create `src/server/actions/supervisor-scope.ts`

```typescript
'use server';

import { db } from '@/db';
import { userAssignments, users } from '@/db/schema';
import { eq, and, sql, inArray } from 'drizzle-orm';

/**
 * Get the list of employee IDs that a supervisor is authorized to review.
 *
 * Logic: A supervisor can review employees who share at least one active CLIN
 * assignment with them. This is derived by:
 * 1. Finding all CLINs the supervisor is assigned to
 * 2. Finding all other users assigned to those same CLINs
 * 3. Returning the unique set of those user IDs (excluding the supervisor themselves)
 *
 * Admin users bypass this entirely — they can review all employees.
 */
export async function getSupervisedEmployeeIds(
  supervisorId: string,
  supervisorRole: string
): Promise<string[] | 'all'> {
  // Admins see everything
  if (supervisorRole === 'admin') {
    return 'all';
  }

  // Get CLINs the supervisor is assigned to
  const supervisorClins = await db
    .select({ clinId: userAssignments.clinId })
    .from(userAssignments)
    .where(
      and(
        eq(userAssignments.userId, supervisorId),
        eq(userAssignments.isActive, true),
      )
    );

  if (supervisorClins.length === 0) {
    return []; // Supervisor has no assignments — can't review anyone
  }

  const clinIds = supervisorClins.map((r) => r.clinId);

  // Get all users assigned to those same CLINs (excluding the supervisor)
  const supervisedUsers = await db
    .select({ userId: userAssignments.userId })
    .from(userAssignments)
    .where(
      and(
        inArray(userAssignments.clinId, clinIds),
        eq(userAssignments.isActive, true),
      )
    );

  // Deduplicate and exclude the supervisor themselves
  const uniqueIds = [...new Set(supervisedUsers.map((r) => r.userId))];
  return uniqueIds.filter((id) => id !== supervisorId);
}

/**
 * Get the contracts shared between a supervisor and their supervised employees.
 * Used for displaying scope context in the UI.
 */
export async function getSupervisorScopeInfo(supervisorId: string): Promise<{
  assignedContractCount: number;
  assignedClinCount: number;
  supervisedEmployeeCount: number;
}> {
  // Count supervisor's CLIN assignments
  const clinAssignments = await db
    .select({ clinId: userAssignments.clinId })
    .from(userAssignments)
    .where(
      and(
        eq(userAssignments.userId, supervisorId),
        eq(userAssignments.isActive, true),
      )
    );

  const clinIds = clinAssignments.map((r) => r.clinId);

  if (clinIds.length === 0) {
    return { assignedContractCount: 0, assignedClinCount: 0, supervisedEmployeeCount: 0 };
  }

  // Count unique employees on those CLINs
  const employees = await db
    .select({ userId: userAssignments.userId })
    .from(userAssignments)
    .where(
      and(
        inArray(userAssignments.clinId, clinIds),
        eq(userAssignments.isActive, true),
      )
    );

  const uniqueEmployees = new Set(employees.map((r) => r.userId));
  uniqueEmployees.delete(supervisorId); // Don't count self

  // Count unique contracts (via CLINs)
  // For simplicity, we count unique CLINs; contract count would require a join
  return {
    assignedContractCount: 0, // Will be enriched in Phase B if needed
    assignedClinCount: clinIds.length,
    supervisedEmployeeCount: uniqueEmployees.size,
  };
}
```

---

### Phase B: Update Period Queries for Scope (B1)

#### B1. Modify `src/server/actions/periods.ts`

Add a new function that returns scoped periods. Add this at the END of the file (do not modify existing functions):

```typescript
/**
 * Get all timesheet periods that a supervisor is authorized to review.
 * Filters based on contract-based scope (shared CLIN assignments).
 *
 * @param scopedEmployeeIds - Array of employee IDs the supervisor can review, or 'all' for admins
 */
export async function getScopedPeriods(
  scopedEmployeeIds: string[] | 'all'
): Promise<Array<{
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  periodStart: Date;
  status: PeriodStatus;
  submittedAt: Date | null;
  reviewedAt: Date | null;
}>> {
  if (scopedEmployeeIds === 'all') {
    // Admin — return all periods (existing behavior)
    return getAllPeriods();
  }

  if (scopedEmployeeIds.length === 0) {
    return []; // Supervisor has no employees in scope
  }

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
    .where(inArray(timesheetPeriods.userId, scopedEmployeeIds))
    .orderBy(timesheetPeriods.submittedAt);

  return rows;
}

/**
 * Get pending approvals scoped to a supervisor's employees.
 */
export async function getScopedPendingApprovals(
  scopedEmployeeIds: string[] | 'all'
): Promise<Array<{
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  periodStart: Date;
  status: PeriodStatus;
  submittedAt: Date | null;
}>> {
  if (scopedEmployeeIds === 'all') {
    return getPendingApprovals();
  }

  if (scopedEmployeeIds.length === 0) {
    return [];
  }

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
    .where(
      and(
        eq(timesheetPeriods.status, 'submitted'),
        inArray(timesheetPeriods.userId, scopedEmployeeIds),
      )
    )
    .orderBy(timesheetPeriods.submittedAt);

  return rows;
}
```

Add the `inArray` import to the existing imports at the top of the file:

```typescript
import { eq, and, inArray } from 'drizzle-orm';
```

---

### Phase C: Update Approvals Page (C1–C2)

#### C1. Modify `src/app/(app)/admin/approvals/page.tsx`

Replace the existing page to use scoped queries:

```tsx
import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { getScopedPeriods } from '@/server/actions/periods';
import { getSupervisedEmployeeIds, getSupervisorScopeInfo } from '@/server/actions/supervisor-scope';
import { ApprovalsClient } from './ApprovalsClient';

export const dynamic = 'force-dynamic';

export default async function ApprovalsPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  const role = (session.user as any).role;
  if (role !== 'admin' && role !== 'supervisor') redirect('/timesheet');

  const userId = session.user.id!;

  // Get supervisor's scope
  const scopedEmployeeIds = await getSupervisedEmployeeIds(userId, role);
  const periods = await getScopedPeriods(scopedEmployeeIds);

  // Get scope metadata for UI display
  const scopeInfo = role === 'supervisor'
    ? await getSupervisorScopeInfo(userId)
    : null;

  return (
    <ApprovalsClient
      initialPeriods={periods}
      currentUserId={userId}
      userRole={role}
      scopeInfo={scopeInfo}
    />
  );
}
```

#### C2. Modify `src/app/(app)/admin/approvals/ApprovalsClient.tsx`

Update the component to accept and display scope information:

**C2a.** Update the `Props` type:

```typescript
type ScopeInfo = {
  assignedContractCount: number;
  assignedClinCount: number;
  supervisedEmployeeCount: number;
} | null;

type Props = {
  initialPeriods: Period[];
  currentUserId: string;
  userRole: string;
  scopeInfo: ScopeInfo;
};
```

**C2b.** Update the component signature:

```typescript
export function ApprovalsClient({ initialPeriods, currentUserId, userRole, scopeInfo }: Props) {
```

**C2c.** Add scope info display at the top of the component's return JSX, before the MRT table:

```tsx
{/* Scope information banner */}
{userRole === 'supervisor' && scopeInfo && (
  <Paper withBorder p="sm" mb="md" radius="md">
    <Group gap="lg">
      <Text size="sm" c="dimmed">
        <strong>Your Approval Scope:</strong> You can review timesheets for{' '}
        <Badge variant="light" color="blue" size="sm">{scopeInfo.supervisedEmployeeCount}</Badge>{' '}
        employees across{' '}
        <Badge variant="light" color="green" size="sm">{scopeInfo.assignedClinCount}</Badge>{' '}
        CLINs you are assigned to.
      </Text>
    </Group>
  </Paper>
)}

{userRole === 'admin' && (
  <Paper withBorder p="sm" mb="md" radius="md">
    <Text size="sm" c="dimmed">
      <Badge variant="light" color="red" size="sm">Admin</Badge>{' '}
      You have full access to all employee timesheets.
    </Text>
  </Paper>
)}

{/* Empty state for supervisors with no assignments */}
{userRole === 'supervisor' && scopeInfo && scopeInfo.supervisedEmployeeCount === 0 && (
  <Paper withBorder p="xl" ta="center" radius="md">
    <Text size="lg" c="dimmed" mb="sm">No Employees in Your Scope</Text>
    <Text size="sm" c="dimmed">
      You are not assigned to any CLINs, so there are no employees whose timesheets you can review.
      Contact your administrator to get assigned to the appropriate contracts and CLINs.
    </Text>
  </Paper>
)}
```

**C2d.** Add the `Paper` and `Badge` imports if not already present:

```typescript
import { Paper, Badge } from '@mantine/core';
```

---

### Phase D: Server-Side Approval Authorization (D1)

#### D1. Modify `src/server/actions/periods.ts` — Add scope validation to `approvePeriod` and `rejectPeriod`

Add authorization checks at the beginning of both functions to ensure the reviewer has scope over the employee.

**D1a.** Add these imports at the top of the file:

```typescript
import { getSupervisedEmployeeIds } from '@/server/actions/supervisor-scope';
```

**D1b.** In `approvePeriod()`, after the existing validation checks, add:

```typescript
  // Verify the reviewer has scope over this employee
  const reviewerRole = await getReviewerRole(data.reviewedBy);
  if (reviewerRole !== 'admin') {
    const scopedIds = await getSupervisedEmployeeIds(data.reviewedBy, reviewerRole);
    if (scopedIds !== 'all' && !scopedIds.includes(existing[0].userId)) {
      throw new Error('Unauthorized: You are not authorized to approve this employee\'s timesheet. You do not share any CLIN assignments.');
    }
  }
```

**D1c.** In `rejectPeriod()`, add the same check after existing validation:

```typescript
  // Verify the reviewer has scope over this employee
  const reviewerRole = await getReviewerRole(data.reviewedBy);
  if (reviewerRole !== 'admin') {
    const scopedIds = await getSupervisedEmployeeIds(data.reviewedBy, reviewerRole);
    if (scopedIds !== 'all' && !scopedIds.includes(existing[0].userId)) {
      throw new Error('Unauthorized: You are not authorized to reject this employee\'s timesheet. You do not share any CLIN assignments.');
    }
  }
```

**D1d.** Add a helper function to get the reviewer's role (at the bottom of the file):

```typescript
async function getReviewerRole(userId: string): Promise<string> {
  const [user] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, userId));
  return user?.role ?? 'employee';
}
```

---

## 4. Verification

### 4a. Build Check

```bash
npm run build
```

Must complete with **zero errors**.

### 4b. Scope Behavior Checks

**Setup prerequisites:**
- Contract A with CLIN-A1
- Contract B with CLIN-B1
- Supervisor S assigned to CLIN-A1
- Employee E1 assigned to CLIN-A1 (shared with S)
- Employee E2 assigned to CLIN-B1 (NOT shared with S)
- Admin A (no specific assignments needed)

| Check | Expected Result |
|---|---|
| **Supervisor S visits /admin/approvals** | Sees only E1's timesheets; E2's timesheets are NOT visible |
| **Scope banner for Supervisor S** | Shows "1 employee across 1 CLIN" |
| **Admin A visits /admin/approvals** | Sees ALL timesheets (E1 and E2) |
| **Admin scope banner** | Shows "Admin — full access to all employee timesheets" |
| **Supervisor S tries to approve E2's timesheet (API)** | Error: "Unauthorized: You are not authorized..." |
| **Supervisor S approves E1's timesheet** | Succeeds normally |
| **Supervisor with no assignments** | Sees empty state: "No Employees in Your Scope" |

### 4c. Edge Cases

| Edge Case | Expected Behavior |
|---|---|
| **Supervisor assigned to same CLIN as employee, then CLIN deactivated** | Employee disappears from scope (query filters `isActive=true`) |
| **Supervisor's assignment removed mid-period** | Employee's pending timesheet disappears from supervisor's view |
| **Employee has multiple CLINs, supervisor shares only one** | Supervisor sees the full timesheet (all CLINs) for that employee |
| **Two supervisors share CLINs with the same employee** | Both supervisors can see and approve the employee's timesheet |
| **Supervisor tries to approve their own timesheet** | Not possible — supervisor's own ID is excluded from scope |

### 4d. Regression Checks

| Check | Expected Result |
|---|---|
| **Existing approval workflow** | Still works for admins with no behavior change |
| **Submit modal** | Unchanged — employees still submit normally |
| **Rejection flow** | Still returns timesheet to draft status |
| **Audit trail** | `reviewed_by` field still correctly populated |

### 4e. Common Errors to Watch For

| Error | Root Cause | Fix |
|---|---|---|
| `inArray` import missing | Not imported from `drizzle-orm` | Add `inArray` to the import |
| Empty array passed to `inArray` | Supervisor has zero assignments | Return early with empty array before calling `inArray` |
| Circular import | `supervisor-scope.ts` imports from `periods.ts` which imports from `supervisor-scope.ts` | Keep scope queries in a separate file; periods.ts should NOT import from supervisor-scope.ts directly — let the page.tsx orchestrate |
| `getSupervisedEmployeeIds` returns stale data | Assignments changed after page load | Use `force-dynamic` on the page (already set) |
| Supervisor can't see any timesheets | No CLIN assignments | Show the empty state message with instructions to contact admin |
